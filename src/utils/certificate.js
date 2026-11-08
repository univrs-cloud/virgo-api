import fs from 'fs/promises';
import { Resolver } from 'dns/promises';
import config from '../../config.js';
import docker from './docker_client.js';
import * as traefikConfig from './traefik_config.js';

const ACME_STORE = { le: '/messier/apps/traefik/letsencrypt/acme.json', ledns: '/messier/apps/traefik/letsencrypt/acme-dns.json' };
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVE_TIMEOUT_MS = 5000;
const TRAEFIK_LABELS = ['com.docker.compose.project=traefik', 'com.docker.compose.service=traefik'];
const TRAEFIK_LOG_LINES = 500;
const ACME_FAILURE = 'unable to obtain acme certificate for domain';
const LOG_HEADER_BYTES = 8;

const readCertificateDomains = async (resolver) => {
	const path = ACME_STORE[resolver];
	if (!path) {
		return [];
	}

	try {
		const store = JSON.parse(await fs.readFile(path, 'utf8'));
		return Object.values(store)
			.flatMap((entry) => { return entry?.Certificates || []; })
			.flatMap((certificate) => { return [certificate?.domain?.main, ...(certificate?.domain?.sans || [])]; })
			.filter(Boolean);
	} catch (error) {
		return [];
	}
};

const resolves = async (fqdn) => {
	const resolver = new Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 });
	resolver.setServers(PUBLIC_RESOLVERS);
	try {
		const addresses = await resolver.resolve4(fqdn);
		return addresses.length > 0;
	} catch (error) {
		return false;
	}
};

const isFleetZone = (fqdn) => {
	return String(fqdn || '').toLowerCase().endsWith(`.${config.fleet.zone}`);
};

const getStatus = async (fqdn, resolver) => {
	if (!fqdn || !resolver) {
		return 'unconfigured';
	}

	const domains = await readCertificateDomains(resolver);
	if (domains.includes(fqdn) || domains.includes(`*.${fqdn}`)) {
		return 'issued';
	}

	return (await resolves(fqdn) ? 'pending' : 'unresolved');
};

const demuxLogs = (output) => {
	if (!Buffer.isBuffer(output)) {
		return String(output || '');
	}

	const chunks = [];
	let offset = 0;
	while (offset + LOG_HEADER_BYTES <= output.length) {
		const size = output.readUInt32BE(offset + 4);
		chunks.push(output.subarray(offset + LOG_HEADER_BYTES, offset + LOG_HEADER_BYTES + size));
		offset += LOG_HEADER_BYTES + size;
	}
	return Buffer.concat(chunks).toString('utf8');
};

const readTraefikLogs = async () => {
	const [container] = await docker.listContainers({ filters: { label: TRAEFIK_LABELS } });
	if (!container) {
		return [];
	}

	const output = await docker.getContainer(container.Id).logs({ stdout: true, stderr: true, tail: TRAEFIK_LOG_LINES });
	return demuxLogs(output).split('\n');
};

const parseAcmeError = (line) => {
	const match = line.match(/ error=("(?:[^"\\]|\\.)*")/);
	if (!match) {
		return null;
	}

	try {
		const lastLine = JSON.parse(match[1]).split('\n').map((part) => { return part.trim(); }).filter(Boolean).pop() || '';
		const message = lastLine.split(' :: ').pop().replace(/^\[[^\]]*\]\s*/, '').replace(/[:\s]+$/, '');
		return message || null;
	} catch (error) {
		return null;
	}
};

const readAcmeError = async (fqdn) => {
	const names = [`"${fqdn.toLowerCase()}"`, `"*.${fqdn.toLowerCase()}"`];
	try {
		const line = (await readTraefikLogs()).findLast((line) => {
			const lowerLine = line.toLowerCase();
			return lowerLine.includes(ACME_FAILURE) && names.some((name) => { return lowerLine.includes(name); });
		});
		return (line ? parseAcmeError(line) : null);
	} catch (error) {
		console.error('readAcmeError:', error);
		return null;
	}
};

const getReason = (fqdn, status, acmeError) => {
	if (status.toLowerCase() === 'issued') {
		return null;
	}

	if (status.toLowerCase() === 'unconfigured') {
		return 'Traefik has no domain or certificate resolver configured. Check the node\'s logs.';
	}

	if (status.toLowerCase() === 'unresolved') {
		return `${fqdn} does not resolve yet. DNS may still be propagating, or the record was not created.`;
	}

	const cause = (acmeError
		? `Let's Encrypt could not issue a certificate for ${fqdn}: ${acmeError.replace(/[^.!?]$/, '$&.')}`
		: `Let's Encrypt has not issued a certificate for ${fqdn} yet.`);
	if (isFleetZone(fqdn)) {
		return `${cause} The check runs through fleet: make sure this node can reach fleet and that the router does not intercept DNS on port 53.`;
	}

	return `${cause} Let's Encrypt has to reach this node on TCP 80: make sure port 80 is forwarded to this node, that the A record points to your public IP, and that the connection is not behind CGNAT.`;
};

const read = async () => {
	const fqdn = traefikConfig.getDomain();
	const resolver = traefikConfig.getCertresolver();
	const status = await getStatus(fqdn, resolver);
	const acmeError = (status.toLowerCase() === 'pending' ? await readAcmeError(fqdn) : null);
	return {
		fqdn,
		status,
		reason: getReason(fqdn, status, acmeError),
		canSkip: !isFleetZone(fqdn)
	};
};

export { read };

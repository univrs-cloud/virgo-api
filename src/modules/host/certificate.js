import fs from 'fs/promises';
import { Resolver } from 'dns/promises';
import * as traefikConfig from '../../utils/traefik_config.js';

const ACME_STORE = { le: '/messier/apps/traefik/letsencrypt/acme.json', ledns: '/messier/apps/traefik/letsencrypt/acme-dns.json' };
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVE_TIMEOUT_MS = 5000;

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

const read = async () => {
	const fqdn = traefikConfig.getDomain();
	const resolver = traefikConfig.getCertresolver();
	if (!fqdn || !resolver) {
		return { fqdn, resolver, required: false, hasCertificate: false, resolves: false };
	}

	const domains = await readCertificateDomains(resolver);
	return {
		fqdn,
		resolver,
		required: true,
		hasCertificate: domains.includes(fqdn) || domains.includes(`*.${fqdn}`),
		resolves: await resolves(fqdn)
	};
};

const publish = async (module) => {
	const certificate = await read();
	module.setState('certificate', certificate);
	module.nsp.emit('host:certificate', certificate);
	return certificate;
};

const onConnection = (socket, module) => {
	socket.on('host:certificate:fetch', async () => {
		if (!socket.isAuthenticated) {
			return;
		}

		socket.emit('host:certificate', await publish(module));
	});
};

export default {
	name: 'certificate',
	onConnection
};

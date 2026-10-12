import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { execa } from 'execa';
import { Queue, QueueEvents } from 'bullmq';
import config from '../../../config.js';
import DataService from '../../database/data_service.js';
import { getCoreApps, getCoreAppTitle } from '../../utils/core_apps.js';
import { getOwnAddress } from '../../utils/network.js';
import docker from '../../utils/docker_client.js';
import { getQueueName } from '../../queues.js';

const APPS_DIR = '/messier/apps';
const COMPOSE_DIR = '.docker';
const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/gm;
const TERMINAL_APP = 'wetty';
const REDIS_CONNECTION = { host: config.redis.host, port: config.redis.port };
const CHILD_JOB_OPTIONS = { removeOnComplete: 100, removeOnFail: 100 };
// Nothing can be signed into until these exist: traefik answers on the node's name, authelia owns the
// accounts and the file the password step writes to. DOMAIN is the node's own name, which each
// template prefixes itself, routing to traefik.<fqdn> and auth.<fqdn>. Certificates come from Let's
// Encrypt, with expiry notices going to us rather than the customer — they never asked for one, and
// it is obtained on their node's behalf.
const SSL_EMAIL = 'voyager@univrs.cloud';
const isFleetZone = (fqdn) => { return String(fqdn || '').toLowerCase().endsWith(`.${config.fleet.zone}`); };
const CORE_APP_ENV = {
	authelia: ({ fqdn }) => { return { DOMAIN: fqdn, CERTRESOLVER: (isFleetZone(fqdn) ? '' : 'le') }; },
	traefik: ({ fqdn }) => { return { DOMAIN: fqdn, CERTRESOLVER: (isFleetZone(fqdn) ? 'ledns' : 'le'), TRAEFIK_DASHBOARD_CERTRESOLVER: (isFleetZone(fqdn) ? '' : 'le'), EMAIL: SSL_EMAIL }; },
	wetty: ({ fqdn, address }) => { return { DOMAIN: fqdn, CERTRESOLVER: (isFleetZone(fqdn) ? '' : 'le'), SSHHOST: address }; }
};

const getNodeAddress = async () => {
	const { virtualIp } = await DataService.getConfiguration();
	return getOwnAddress(virtualIp?.address);
};

const getFqdn = async () => {
	const { stdout } = await execa('hostname', ['-f'], { reject: false });
	return String(stdout || '').split('\n')[0].trim();
};

const readAppEnv = async (name) => {
	try {
		const content = await fs.readFile(path.join(APPS_DIR, name, COMPOSE_DIR, '.env'), 'utf-8');
		return Object.fromEntries([...content.matchAll(ENV_LINE_PATTERN)].map(([, key, value]) => { return [key, value]; }));
	} catch (error) {
		return null;
	}
};

const hasCurrentEnv = async (name, env) => {
	const installedEnv = await readAppEnv(name);
	if (!installedEnv) {
		return false;
	}

	const keys = Object.keys(env);
	return Object.keys(installedEnv).length === keys.length
		&& keys.every((key) => { return String(installedEnv[key] ?? '').toLowerCase() === String(env[key] ?? '').toLowerCase(); });
};

const isAppRunning = async (name) => {
	try {
		const containers = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${name}`, `com.docker.compose.service=${name}`] } });
		return containers.some((container) => { return ['running', 'restarting'].includes(String(container.State).toLowerCase()); });
	} catch (error) {
		return false;
	}
};

const getInstalledCoreApps = async (names) => {
	const installed = [];
	for (const name of names) {
		if (await DataService.getApplication(name)) {
			installed.push(name);
		}
	}

	return installed;
};

const getOutdatedCoreApps = async (names) => {
	const fqdn = await getFqdn();
	const address = await getNodeAddress();
	if (!fqdn || !address) {
		return names;
	}

	const outdated = [];
	for (const name of names) {
		if (!await hasCurrentEnv(name, CORE_APP_ENV[name]({ fqdn, address }))) {
			outdated.push(name);
		}
	}

	return outdated;
};

const requestCoreApps = async (config, socket, module) => {
	const installed = await getInstalledCoreApps(getCoreApps());
	const outdated = await getOutdatedCoreApps(installed);
	const apps = [];
	for (const name of getCoreApps()) {
		if (!installed.includes(name) || outdated.includes(name) || !await isAppRunning(name)) {
			apps.push(name);
		}
	}

	if (!apps.length) {
		return { status: 'succeeded' };
	}

	const job = await module.addJob('host:apps:core:install', { config: { apps }, username: socket.username });
	return (job ? { status: 'succeeded' } : { status: 'failed', message: 'Could not start job' });
};

const reinstallCoreApps = async (job, module, apps) => {
	if (!apps.length) {
		return;
	}

	const fqdn = await getFqdn();
	const address = await getNodeAddress();
	if (!fqdn || !address) {
		throw new Error('Core apps were not reinstalled: this node has no name or address.');
	}

	await module.updateJobProgress(job, `Reinstalling ${apps.map(getCoreAppTitle).join(', ')}...`);
	const queueName = getQueueName('docker');
	const queue = new Queue(queueName, { connection: REDIS_CONNECTION });
	const queueEvents = new QueueEvents(queueName, { connection: REDIS_CONNECTION });
	try {
		await queueEvents.waitUntilReady();
		const children = [];
		for (const name of apps) {
			children.push(await queue.add(
				'app:install',
				{ config: { name, env: CORE_APP_ENV[name]({ fqdn, address }), force: true }, username: job.data?.username },
				{ ...CHILD_JOB_OPTIONS, jobId: randomUUID(), parent: { id: job.id, queue: job.queueQualifiedName } }
			));
		}

		const results = await Promise.allSettled(children.map((child) => { return child.waitUntilFinished(queueEvents); }));
		const failedApps = apps.filter((name, index) => { return results[index].status === 'rejected'; }).map(getCoreAppTitle);
		if (failedApps.length) {
			throw new Error(`Could not reinstall ${failedApps.join(' and ')}.`);
		}
	} finally {
		await queueEvents.close();
		await queue.close();
	}
};

const reinstallRenamedCoreApps = async (job, module) => {
	await reinstallCoreApps(job, module, await getInstalledCoreApps(getCoreApps()));
};

const reinstallReaddressedTerminal = async (job, module) => {
	await reinstallCoreApps(job, module, await getOutdatedCoreApps(await getInstalledCoreApps([TERMINAL_APP])));
};

/** Queues the apps the node cannot be used without, through the same command an operator would run.
 * The command returns once the work is queued; the installs themselves report their own progress.
 * Forced, because an imported pool already lists them: they are reconfigured for this node's name.
 * They are named after the node, so without a name there is nothing to install — a job that
 * reported that as done would be claiming work it never did. */
const installCoreApps = async (job, module) => {
	const fqdn = await getFqdn();
	if (!fqdn) {
		throw new Error('Core apps were not installed: this node has no name yet.');
	}

	const address = await getNodeAddress();
	if (!address) {
		throw new Error('Core apps were not installed: this node has no address yet.');
	}

	// Every app is attempted before the job gives up: they are independent, and one that fails should not
	// hide whether the other would have worked. What failed is reported once, at the end.
	const failedApps = [];
	for (const name of (job.data?.config?.apps || getCoreApps())) {
		const title = getCoreAppTitle(name);
		await module.updateJobProgress(job, `Installing ${title}...`);
		const { exitCode, stderr } = await execa('virgo', ['apps', 'install', name, '--force', '--env-json', JSON.stringify(CORE_APP_ENV[name]({ fqdn, address }))], { reject: false });
		if (exitCode !== 0) {
			failedApps.push(title);
			console.error(`Could not install ${title}: ${stderr}`);
		}
	}

	if (failedApps.length) {
		throw new Error(`Could not install ${failedApps.join(' and ')}.`);
	}

	return `Core apps installed.`;
};

export default {
	name: 'core_apps',
	commands: {
		'host:apps:core:install': { handler: requestCoreApps }
	},
	jobs: {
		'host:apps:core:install': installCoreApps
	},
	reinstallRenamedCoreApps,
	reinstallReaddressedTerminal
};

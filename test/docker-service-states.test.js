import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import camelcaseKeys from 'camelcase-keys';
import dockerCompose from 'docker-compose';
import DataService from '../src/database/data_service.js';
import { DockerModule } from '../src/modules/docker/index.js';
import docker from '../src/utils/docker_client.js';
import performAction from '../src/modules/docker/perform_action.js';

// Runs an app update against real containers: needs a Docker daemon, and is skipped without one.
const hasDocker = await docker.ping().then(() => { return true; }, () => { return false; });
const IMAGE = 'busybox:1.36';

const stoppedServices = new Map();
DataService.getStoppedServices = async (name) => { return [...(stoppedServices.get(name) ?? [])]; };
DataService.setStoppedServices = async (name, services) => { stoppedServices.set(name, [...new Set(services)].sort()); return true; };
DataService.getApplication = async (name) => { return { name, title: name }; };
DataService.hasApplication = async () => { return true; };

let dir;
let project;
let count = 0;
const options = () => { return { cwd: dir, composeOptions: [['-p', project]], commandOptions: ['--remove-orphans'] }; };

const writeCompose = async ({ version = 1, workerCommand = ['sleep', '3600'], extra = false } = {}) => {
	const service = (command, dependsOn) => {
		return {
			image: IMAGE,
			init: true,
			command,
			environment: { VERSION: String(version) },
			...(dependsOn ? { depends_on: dependsOn } : {})
		};
	};
	const services = {
		redis: service(['sleep', '3600']),
		web: service(['sleep', '3600'], ['redis']),
		worker: service(workerCommand)
	};
	if (extra) {
		services.extra = service(['sleep', '3600'], ['redis']);
	}
	await fs.writeFile(path.join(dir, 'docker-compose.yml'), JSON.stringify({ services }), 'utf-8');
};

const containers = async () => {
	const all = camelcaseKeys(await docker.listContainers({ all: true }), { deep: true });
	return all.filter((container) => { return container.labels?.comDockerComposeProject === project; });
};

const states = async () => {
	const result = {};
	for (const container of await containers()) {
		result[container.labels.comDockerComposeService] = container.state;
	}
	return result;
};

const container = async (service) => {
	return (await containers()).find((entry) => { return entry.labels.comDockerComposeService === service; });
};

// What the update job does: read the containers, change the project files, bring the project up.
const update = async (compose) => {
	const before = await containers();
	await writeCompose({ version: 2, ...compose });
	await DockerModule.prototype.upKeepingServiceStates.call({}, project, before, options());
};

before(async () => {
	if (hasDocker) {
		await docker.pull(IMAGE).then((stream) => { return new Promise((resolve) => { docker.modem.followProgress(stream, resolve); }); });
	}
});

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virgo-service-states-'));
	project = `virgo-test-states-${process.pid}-${count++}`;
	stoppedServices.clear();
	await writeCompose();
	await dockerCompose.upAll(options());
});

after(async () => {
	for (let index = 0; index < count; index++) {
		await dockerCompose.down({ cwd: dir, composeOptions: [['-p', `virgo-test-states-${process.pid}-${index}`]], commandOptions: ['-v', '-t', '0'] }).catch(() => {});
	}
});

const opts = { skip: !hasDocker && 'no Docker daemon' };

test('with nothing stopped, every service is updated and running', opts, async () => {
	const old = await container('web');
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'running' });
	assert.notEqual((await container('web')).id, old.id);
});

test('a service the user stopped is updated but stays stopped', opts, async () => {
	const old = await container('worker');
	await docker.getContainer(old.id).stop();
	stoppedServices.set(project, ['worker']);
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'created' });
	assert.notEqual((await container('worker')).id, old.id);
	assert.deepEqual(stoppedServices.get(project), ['worker']);
});

test('a service that crashed is started by the update', opts, async () => {
	await writeCompose({ workerCommand: ['sh', '-c', 'exit 1'] });
	await dockerCompose.upAll(options());
	await new Promise((resolve) => { setTimeout(resolve, 1000); });
	assert.equal((await states()).worker, 'exited');
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'running' });
});

test('a dependency the user stopped is started for the service that needs it', opts, async () => {
	await docker.getContainer((await container('redis')).id).stop();
	stoppedServices.set(project, ['redis']);
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'running' });
});

test('a paused service is paused again after the update', opts, async () => {
	const old = await container('web');
	await docker.getContainer(old.id).pause();
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'paused', worker: 'running' });
	assert.notEqual((await container('web')).id, old.id);
});

test('an app the user stopped stays stopped, even with a service new in the update', opts, async () => {
	for (const entry of await containers()) {
		await docker.getContainer(entry.id).stop();
	}
	stoppedServices.set(project, ['redis', 'web', 'worker']);
	await update({ extra: true });
	assert.deepEqual(await states(), { extra: 'created', redis: 'created', web: 'created', worker: 'created' });
});

test('a stopped service the user did not stop is started, even when others were stopped by the user', opts, async () => {
	await docker.getContainer((await container('worker')).id).stop();
	await docker.getContainer((await container('web')).id).stop();
	stoppedServices.set(project, ['web']);
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'created', worker: 'running' });
});

test('a stopped service started again outside the app is not kept stopped', opts, async () => {
	stoppedServices.set(project, ['worker', 'gone']);
	await update();
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'running' });
	assert.deepEqual(stoppedServices.get(project), []);
});

// The parts of the docker module the action jobs use.
const actionModule = () => {
	return {
		nlp: { conjugate: (verb) => { return { gerund: `${verb}ing`, pastTense: `${verb}ed` }; } },
		withAppLock: (name, task) => { return task(); },
		updateJobProgress: async () => {},
		findContainersByAppName: async () => { return containers(); }
	};
};
const serviceAction = async (service, action) => {
	const { id } = await container(service);
	await performAction.jobs['app:service:performAction']({ data: { config: { id, action } } }, actionModule());
};
const appAction = async (action) => {
	await performAction.jobs['app:performAction']({ data: { config: { name: project, action } } }, actionModule());
};

test('stopping or killing a service from the app records it, starting or restarting it forgets it', opts, async () => {
	await serviceAction('worker', 'stop');
	await serviceAction('web', 'kill');
	assert.deepEqual(stoppedServices.get(project), ['web', 'worker']);
	await serviceAction('worker', 'start');
	assert.deepEqual(stoppedServices.get(project), ['web']);
	await serviceAction('web', 'restart');
	assert.deepEqual(stoppedServices.get(project), []);
});

test('pausing a service from the app does not record it as stopped', opts, async () => {
	await serviceAction('web', 'pause');
	await serviceAction('web', 'unpause');
	assert.equal(stoppedServices.get(project), undefined);
});

test('stopping the app records every service, starting it forgets them', opts, async () => {
	await appAction('stop');
	assert.deepEqual(stoppedServices.get(project), ['redis', 'web', 'worker']);
	await update();
	assert.deepEqual(await states(), { redis: 'created', web: 'created', worker: 'created' });
	await appAction('start');
	assert.deepEqual(stoppedServices.get(project), []);
	assert.deepEqual(await states(), { redis: 'running', web: 'running', worker: 'running' });
});

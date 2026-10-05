import fs from 'fs/promises';
import path from 'path';
import { execa } from 'execa';

const COMPOSE_DATASET = 'messier/docker/compose';
const OLD_COMPOSE_DIR = '/opt/docker';
const APPS_DIR = '/messier/apps';
const COMPOSE_DIR = '.docker';
const COMPOSE_FILES = ['docker-compose.yml', '.env'];

const moveComposeFiles = async () => {
	const { exitCode } = await execa('zfs', ['list', COMPOSE_DATASET], { reject: false });
	if (exitCode !== 0) {
		console.log(`Dataset ${COMPOSE_DATASET} does not exist. Skipping compose files move.`);
		return;
	}

	for (const name of await fs.readdir(OLD_COMPOSE_DIR)) {
		const oldProjectDir = path.join(OLD_COMPOSE_DIR, name);
		const projectDir = path.join(APPS_DIR, name, COMPOSE_DIR);
		await fs.mkdir(projectDir, { recursive: true });
		for (const file of COMPOSE_FILES) {
			await fs.copyFile(path.join(oldProjectDir, file), path.join(projectDir, file));
		}
		await execa('docker', ['compose', 'down'], { cwd: oldProjectDir });
		await execa('docker', ['compose', '-p', name, 'up', '-d'], { cwd: projectDir });
		await fs.rm(oldProjectDir, { recursive: true, force: true });
		console.log(`Moved ${name} to ${projectDir}`);
	}

	await execa('zfs', ['destroy', '-r', COMPOSE_DATASET]);
	await fs.rm(OLD_COMPOSE_DIR, { recursive: true, force: true });
	console.log(`Removed ${COMPOSE_DATASET}.`);
};

export default moveComposeFiles;

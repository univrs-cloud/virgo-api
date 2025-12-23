const { execa } = require('execa');
const fs = require('fs');

// Dataset definitions (order matters: parent datasets must come before children)
const DATASETS = [
	{ name: 'messier/docker', opts: ['-o', 'mountpoint=/var/lib/docker'] },
	{ name: 'messier/containerd', opts: ['-o', 'mountpoint=/var/lib/containerd'] },
	{ name: 'messier/docker/compose', opts: ['-o', 'mountpoint=/opt/docker'] },
	{ name: 'messier/apps', opts: [] },
	{ name: 'messier/time_machines', opts: ['-o', 'mountpoint=/time_machines'] },
	{ name: 'messier/downloads', opts: ['-o', 'mountpoint=/downloads'] }
];

const log = (step, message) => {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] [Step ${step}] ${message}`);
};

const exec = async (command, args = []) => {
	const { stdout } = await execa(command, args);
	return stdout.trim();
};

const execSilent = async (command, args = []) => {
	try {
		const { stdout } = await execa(command, args);
		return { success: true, stdout: stdout.trim() };
	} catch (error) {
		return { success: false, error };
	}
};

const execJson = async (command, args = []) => {
	try {
		const { stdout } = await execa(command, args);
		return { success: true, data: JSON.parse(stdout) };
	} catch (error) {
		return { success: false, error };
	}
};

// Get list of active pool names using JSON output
const getPools = async () => {
	const result = await execJson('zpool', ['list', '-j']);
	if (!result.success || !result.data.pools) return [];
	return Object.keys(result.data.pools);
};

// Get list of importable pools (no JSON support for zpool import)
const getImportablePools = async () => {
	const result = await execSilent('zpool', ['import']);
	if (!result.success) return [];
	const output = result.stdout || '';
	if (output.includes('no pools available to import')) return [];
	// Parse pool names from output (format: "   pool: poolname")
	const poolMatches = output.match(/^\s*pool:\s*(\S+)/gm) || [];
	return poolMatches.map(m => m.replace(/^\s*pool:\s*/, ''));
};

// Get list of existing dataset names using JSON output
const getExistingDatasets = async () => {
	const result = await execJson('zfs', ['list', '-j', '-o', 'name']);
	if (!result.success || !result.data.datasets) return [];
	return Object.keys(result.data.datasets);
};

// Check if a dataset is mounted using JSON output
const isDatasetMounted = async (datasetName) => {
	const result = await execJson('zfs', ['get', '-j', 'mounted', datasetName]);
	if (!result.success || !result.data.datasets) return false;
	const dataset = result.data.datasets[datasetName];
	return dataset?.properties?.mounted?.value === 'yes';
};

const stopDockerServices = async (stepNum) => {
	log(stepNum, `Stopping and disabling Docker services...`);
	await execSilent('systemctl', ['disable', '--now', 'docker.socket']);
	await execSilent('systemctl', ['disable', '--now', 'docker.service']);
	await execSilent('systemctl', ['disable', '--now', 'containerd.service']);
	log(stepNum, `Docker services stopped and disabled`);
};

const startDockerServices = async (stepNum) => {
	log(stepNum, `Starting and enabling Docker services...`);
	await exec('systemctl', ['enable', '--now', 'containerd.service']);
	await exec('systemctl', ['enable', '--now', 'docker.service']);
	await exec('systemctl', ['enable', '--now', 'docker.socket']);
	log(stepNum, `Docker services started and enabled`);
};

const backupDockerData = async (stepNum) => {
	log(stepNum, `Backing up Docker data...`);
	const dockerBackupExists = fs.existsSync('/var/lib/docker.orig');
	const containerdBackupExists = fs.existsSync('/var/lib/containerd.orig');
	const dockerHasContent = fs.existsSync('/var/lib/docker') && fs.readdirSync('/var/lib/docker').length > 0;
	const containerdHasContent = fs.existsSync('/var/lib/containerd') && fs.readdirSync('/var/lib/containerd').length > 0;

	if (dockerHasContent && !dockerBackupExists) {
		log(stepNum, `Creating backup of /var/lib/docker...`);
		await exec('cp', ['-a', '/var/lib/docker', '/var/lib/docker.orig']);
		await exec('sh', ['-c', 'rm -rf /var/lib/docker/*']);
		log(stepNum, `Docker backup created, original emptied`);
	} else if (dockerBackupExists) {
		log(stepNum, `Docker backup already exists, skipping`);
	} else {
		log(stepNum, `No Docker data to backup`);
	}

	if (containerdHasContent && !containerdBackupExists) {
		log(stepNum, `Creating backup of /var/lib/containerd...`);
		await exec('cp', ['-a', '/var/lib/containerd', '/var/lib/containerd.orig']);
		await exec('sh', ['-c', 'rm -rf /var/lib/containerd/*']);
		log(stepNum, `Containerd backup created, original emptied`);
	} else if (containerdBackupExists) {
		log(stepNum, `Containerd backup already exists, skipping`);
	} else {
		log(stepNum, `No Containerd data to backup`);
	}
};

const handleDockerDataAfterMount = async (stepNum) => {
	log(stepNum, `Checking ZFS datasets and handling Docker data...`);
	
	const dockerBackupExists = fs.existsSync('/var/lib/docker.orig');
	const containerdBackupExists = fs.existsSync('/var/lib/containerd.orig');

	// Handle Docker
	if (dockerBackupExists) {
		// Ensure ZFS dataset is mounted before restoring
		let isDockerMounted = await isDatasetMounted('messier/docker');
		if (!isDockerMounted) {
			log(stepNum, `ZFS dataset messier/docker not mounted, attempting mount...`);
			await execSilent('zfs', ['mount', 'messier/docker']);
			isDockerMounted = await isDatasetMounted('messier/docker');
			if (!isDockerMounted) {
				throw new Error('Cannot restore docker data: ZFS dataset messier/docker failed to mount');
			}
			log(stepNum, `ZFS dataset messier/docker mounted successfully`);
		}
		
		const dockerZfsHasData = fs.existsSync('/var/lib/docker') && fs.readdirSync('/var/lib/docker').length > 0;
		
		if (dockerZfsHasData) {
			log(stepNum, `ZFS dataset /var/lib/docker has data, deleting backup...`);
			await exec('rm', ['-rf', '/var/lib/docker.orig']);
			log(stepNum, `Docker backup deleted (ZFS data preserved)`);
		} else {
			log(stepNum, `ZFS dataset /var/lib/docker is empty, restoring from backup...`);
			await exec('sh', ['-c', 'cp -a /var/lib/docker.orig/* /var/lib/docker/ 2>/dev/null || true']);
			await exec('rm', ['-rf', '/var/lib/docker.orig']);
			log(stepNum, `Docker data restored to ZFS and backup removed`);
		}
	}

	// Handle Containerd
	if (containerdBackupExists) {
		// Ensure ZFS dataset is mounted before restoring
		let isContainerdMounted = await isDatasetMounted('messier/containerd');
		if (!isContainerdMounted) {
			log(stepNum, `ZFS dataset messier/containerd not mounted, attempting mount...`);
			await execSilent('zfs', ['mount', 'messier/containerd']);
			isContainerdMounted = await isDatasetMounted('messier/containerd');
			if (!isContainerdMounted) {
				throw new Error('Cannot restore containerd data: ZFS dataset messier/containerd failed to mount');
			}
			log(stepNum, `ZFS dataset messier/containerd mounted successfully`);
		}
		
		const containerdZfsHasData = fs.existsSync('/var/lib/containerd') && fs.readdirSync('/var/lib/containerd').length > 0;
		
		if (containerdZfsHasData) {
			log(stepNum, `ZFS dataset /var/lib/containerd has data, deleting backup...`);
			await exec('rm', ['-rf', '/var/lib/containerd.orig']);
			log(stepNum, `Containerd backup deleted (ZFS data preserved)`);
		} else {
			log(stepNum, `ZFS dataset /var/lib/containerd is empty, restoring from backup...`);
			await exec('sh', ['-c', 'cp -a /var/lib/containerd.orig/* /var/lib/containerd/ 2>/dev/null || true']);
			await exec('rm', ['-rf', '/var/lib/containerd.orig']);
			log(stepNum, `Containerd data restored to ZFS and backup removed`);
		}
	}
};

const setup = async () => {
	console.log(`\n========================================`);
	console.log(`Starting setup at ${new Date().toISOString()}`);
	console.log(`========================================\n`);

	try {
		log(1, `Checking for NVMe drives...`);
		const nvmeResult = await execSilent('ls', ['/dev/disk/by-id/']);
		if (!nvmeResult.success) {
			throw new Error('Failed to list disk devices');
		}
		const nvmeDrives = nvmeResult.stdout
			.split('\n')
			.filter(d => d.startsWith('nvme-eui.') && !d.includes('-part'));
		
		if (nvmeDrives.length < 2) {
			throw new Error(`Expected at least 2 NVMe drives, found ${nvmeDrives.length}: ${nvmeDrives.join(', ')}`);
		}
		log(1, `Found ${nvmeDrives.length} NVMe drives: ${nvmeDrives.join(', ')}`);

		log(2, `Checking if ZFS pool "messier" exists...`);
		const pools = await getPools();
		let poolReady = pools.includes('messier');
		log(2, `Active pools: ${pools.join(', ') || 'none'}`);
		
		if (poolReady) {
			log(2, `Pool "messier" already exists`);
		} else {
			log(3, `Pool not found. Listing importable pools...`);
			const importablePools = await getImportablePools();
			const hasMessier = importablePools.includes('messier');
			
			log(3, importablePools.length === 0
				? `No pools available to import` 
				: `Importable pools: ${importablePools.join(', ')}`);
			
			if (hasMessier) {
				// Pool messier exists and can be imported
				// Must stop docker and backup BEFORE import (ZFS will auto-mount and overwrite)
				await stopDockerServices(4);
				await backupDockerData(5);
				
				log(6, `Importing pool "messier"...`);
				await exec('zpool', ['import', 'messier']);
				poolReady = true;
				log(6, `Pool "messier" imported successfully (datasets auto-mounted)`);
				
				log(7, `Ensuring ZFS datasets exist after import...`);
				const postImportExistingList = await getExistingDatasets();
				
				for (const dataset of DATASETS) {
					if (postImportExistingList.includes(dataset.name)) {
						log(7, `Dataset "${dataset.name}" already exists`);
					} else {
						log(7, `Creating dataset "${dataset.name}"...`);
						await exec('zfs', ['create', ...dataset.opts, dataset.name]);
						log(7, `Dataset "${dataset.name}" created`);
					}
				}
				
				await handleDockerDataAfterMount(8);
				await startDockerServices(9);
				
			} else if (importablePools.length > 0) {
				// Other pools exist but not messier - abort to prevent data loss
				log(4, `Other pools found: ${importablePools.join(', ')}`);
				throw new Error(
					'Other ZFS pools exist on these drives but "messier" not found. Manual intervention required.'
				);
			} else {
				log(4, `No existing pools. Creating new ZFS pool "messier"...`);
				const driveIds = nvmeDrives.slice(0, 2).map(d => `/dev/disk/by-id/${d}`);
				log(4, `Using drives: ${driveIds.join(', ')}`);
				
				await exec('zpool', [
					'create', 'messier', 'mirror',
					...driveIds,
					'-o', 'ashift=13',
					'-o', 'autotrim=on',
					'-O', 'compression=lz4',
					'-O', 'atime=off'
				]);
				poolReady = true;
				log(4, `Pool "messier" created successfully`);
			}
		}

		if (!poolReady) {
			throw new Error('Failed to prepare ZFS pool "messier"');
		}

		log(9, `Creating ZFS datasets if they do not exist...`);
		const existingDatasets = await getExistingDatasets();

		// Check if we need to stop docker before creating datasets with docker mountpoints
		const dockerDatasetsExist = existingDatasets.includes('messier/docker') && existingDatasets.includes('messier/containerd');
		const needToCreateDockerDatasets = !dockerDatasetsExist;
		
		if (needToCreateDockerDatasets) {
			// Stop docker and backup before creating datasets that will mount over docker dirs
			await stopDockerServices(10);
			await backupDockerData(11);
		}

		for (const dataset of DATASETS) {
			if (existingDatasets.includes(dataset.name)) {
				log(9, `Dataset "${dataset.name}" already exists, skipping`);
			} else {
				log(9, `Creating dataset "${dataset.name}"...`);
				await exec('zfs', ['create', ...dataset.opts, dataset.name]);
				log(9, `Dataset "${dataset.name}" created`);
			}
		}

		if (needToCreateDockerDatasets) {
			// Handle docker data after datasets are created and mounted
			await handleDockerDataAfterMount(12);
			await startDockerServices(13);
		}

		log(14, `Checking for interrupted migration...`);
		const dockerBackupExists = fs.existsSync('/var/lib/docker.orig');
		const containerdBackupExists = fs.existsSync('/var/lib/containerd.orig');
		
		if (dockerBackupExists || containerdBackupExists) {
			log(14, `Detected backup folders from interrupted migration. Resuming...`);
			await stopDockerServices(15);
			await handleDockerDataAfterMount(16);
			await startDockerServices(17);
		} else {
			log(14, `No interrupted migration detected`);
		}

		log(18, `Setting up Docker virgo network...`);
		const networkResult = await execJson('docker', ['network', 'inspect', 'virgo', '--format', 'json']);
		if (networkResult.success && Array.isArray(networkResult.data) && networkResult.data.length > 0) {
			log(18, `Docker network "virgo" already exists`);
		} else {
			await exec('docker', [
				'network', 'create',
				'--driver=bridge',
				'--subnet=172.30.0.0/16',
				'--ip-range=172.30.10.0/24',
				'--gateway=172.30.0.1',
				'virgo'
			]);
			log(18, `Docker network "virgo" created`);
		}

		log(19, `Setting directory ownership...`);
		await execSilent('chown', ['voyager:users', '/downloads']);
		await execSilent('chown', ['-R', 'voyager:users', '/messier/apps']);
		log(19, `Ownership set`);

		console.log(`\n========================================`);
		console.log(`Setup completed successfully!`);
		console.log(`========================================\n`);
	} catch (error) {
		console.error(`\n========================================`);
		console.error(`Setup failed: ${error.message}`);
		console.error(`========================================\n`);
		throw error;
	}
};

// Run if this file is executed directly
if (require.main === module) {
	setup().catch(() => process.exit(1));
}

module.exports = setup;

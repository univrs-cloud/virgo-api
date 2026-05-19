const crypto = require('crypto');
const { execa } = require('execa');
const ini = require('ini');
const BaseModule = require('../base');
const TimeMachine = require('../../utils/time_machine');

class ShareModule extends BaseModule {
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];
	#foldersConf = '/messier/.shares/folders.conf';
	#timeMachinesConf = '/messier/.shares/time_machines.conf';
	#foldersDataset = 'messier/folders';
	#timeMachinesDataset = 'messier/time_machines';
	#duCache = new Map();
	#duInflight = new Map();
	#duMinRefreshMs = 5 * 60 * 1000;

	constructor() {
		super('share');

		(async () => {
			await this.#loadShares();
		})();

		this.eventEmitter
			.on('shares:updated', async () => {
				await this.#loadShares();
				this.nsp.emit('shares', this.getState('shares'));
			});
	}

	get configurationFiles() {
		return this.#configurationFiles;
	}

	get foldersConf() {
		return this.#foldersConf;
	}

	get timeMachinesConf() {
		return this.#timeMachinesConf;
	}

	get foldersDataset() {
		return this.#foldersDataset;
	}

	get timeMachinesDataset() {
		return this.#timeMachinesDataset;
	}

	onConnection(socket) {
		if (this.getState('shares')) {
			socket.emit('shares', this.getState('shares'));
		}
	}

	async pathToZfsDataset(sharePath) {
		if (sharePath === null) {
			return null;
		}
		
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'name,mountpoint', '-j']);
		const datasets = JSON.parse(zfsList)?.datasets || {};
		for (const dataset of Object.values(datasets)) {
			if (sharePath === dataset?.properties?.mountpoint?.value) {
				return dataset.name;
			}
		}
		return null;
	}

	refquotaToZfsString(bytes) {
		if (bytes >= 1024 ** 4) return `${Math.floor(bytes / 1024 ** 4)}T`;
		if (bytes >= 1024 ** 3) return `${Math.floor(bytes / 1024 ** 3)}G`;
		if (bytes >= 1024 ** 2) return `${Math.floor(bytes / 1024 ** 2)}M`;
		if (bytes >= 1024) return `${Math.floor(bytes / 1024)}K`;
		return `${bytes}`;
	}

	generateProjectspace(sharePath) {
		const id = crypto.createHash('sha1').update(sharePath).digest().readUInt32BE(0);
		return (id === 0 ? 1 : id);
	}

	async getPathProjectspace(sharePath) {
		try {
			const { stdout: projectOutput } = await execa('zfs', ['project', '-d', sharePath]);
			const match = projectOutput.match(/^\s*(\d+)\s/);
			if (match) {
				const id = parseInt(match[1], 10);
				return (id > 0 ? id : null);
			}
		} catch (error) {
			// path may not exist or filesystem doesn't support project ids
		}
		return null;
	}

	#refreshDu(sharePath) {
		if (this.#duInflight.has(sharePath)) {
			return this.#duInflight.get(sharePath);
		}
		const promise = (async () => {
			try {
				const { stdout: duOutput } = await execa('du', ['-sb', '--apparent-size', sharePath]);
				const alloc = parseInt(duOutput.split(/\s+/)[0], 10);
				this.#duCache.set(sharePath, { alloc, updatedAt: Date.now() });
				this.eventEmitter.emit('shares:updated');
			} catch (error) {
				console.error(`Error computing du for ${sharePath}:`, error);
			} finally {
				this.#duInflight.delete(sharePath);
			}
		})();
		this.#duInflight.set(sharePath, promise);
		return promise;
	}

	async #getProjectspaceUsage(datasetName) {
		try {
			const { stdout: projectspaceOutput } = await execa('zfs', ['projectspace', '-Hp', '-o', 'name,used', datasetName]);
			const usage = new Map();
			for (const line of projectspaceOutput.split('\n').filter(Boolean)) {
				const [id, used] = line.split('\t');
				usage.set(parseInt(id, 10), parseInt(used, 10));
			}
			return usage;
		} catch (error) {
			console.error(`Error reading projectspace for ${datasetName}:`, error);
			return new Map();
		}
	}

	async #getZfsDatasets() {
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'name,mountpoint,used,available,referenced,refquota', '-j', '--json-int']);
		const datasets = JSON.parse(zfsList)?.datasets || {};
		return Object.values(datasets).map((dataset) => {
			const props = dataset.properties || {};
			return {
				name: dataset.name,
				mountpoint: props.mountpoint?.value,
				used: props.used?.value ?? null,
				available: props.available?.value ?? null,
				referenced: props.referenced?.value ?? null,
				refquota: props.refquota?.value || null
			};
		});
	}

	async #loadShares() {
		try {
			const response = await execa('testparm', ['-s', '-l']);
			const shares = ini.parse(response.stdout);
			delete shares.global;

			const datasets = await this.#getZfsDatasets();
			const datasetByMountpoint = new Map(datasets.map((dataset) => { return [dataset.mountpoint, dataset]; }));

			const findParentDataset = (sharePath) => {
				return datasets
					.filter((dataset) => { return dataset.mountpoint && sharePath.startsWith(dataset.mountpoint.replace(/\/?$/, '/')); })
					.sort((a, b) => { return b.mountpoint.length - a.mountpoint.length; })[0];
			};

			const customPaths = Object.values(shares)
				.map((value) => { return value['path']; })
				.filter((sharePath) => { return sharePath && !datasetByMountpoint.has(sharePath); });
			const projectspaceByPath = new Map();
			await Promise.all(customPaths.map(async (sharePath) => {
				const projectspace = await this.getPathProjectspace(sharePath);
				if (projectspace !== null) {
					projectspaceByPath.set(sharePath, projectspace);
				}
			}));
			const projectspaceDatasets = new Set();
			for (const sharePath of projectspaceByPath.keys()) {
				const parent = findParentDataset(sharePath);
				if (parent) projectspaceDatasets.add(parent.name);
			}
			const projectspaceUsageByDataset = new Map();
			await Promise.all([...projectspaceDatasets].map(async (datasetName) => {
				projectspaceUsageByDataset.set(datasetName, await this.#getProjectspaceUsage(datasetName));
			}));

			let promises = Object.entries(shares).map(async ([name, value]) => {
				let share = {
					name: name,
					comment: value['comment'],
					path: value['path'],
					dataset: null,
					validUsers: value['valid users']?.split(/[\s,]+/).filter(Boolean),
					size: 0,
					free: 0,
					alloc: 0,
					cap: 0,
					isPrivate: (value['guest ok']?.toLowerCase() !== 'yes'),
					isTimeMachine: (value['fruit:time machine'] === 'yes')
				};
				try {
					const dataset = datasetByMountpoint.get(value['path']);
					if (dataset) {
						share.dataset = dataset.name;
						share.alloc = dataset.referenced ?? 0;
						share.size = dataset.refquota ?? ((dataset.used ?? 0) + (dataset.available ?? 0));
						share.free = Math.max(share.size - share.alloc, 0);
					} else if (value['path']) {
						const parent = findParentDataset(value['path']);
						const projectspace = projectspaceByPath.get(value['path']) ?? null;
						const projectspaceUsed = (projectspace !== null && parent)
							? projectspaceUsageByDataset.get(parent.name)?.get(projectspace)
							: undefined;
						if (projectspaceUsed !== undefined) {
							share.alloc = projectspaceUsed;
						} else {
							const cached = this.#duCache.get(value['path']);
							share.alloc = cached?.alloc ?? 0;
							const stale = !cached || (Date.now() - cached.updatedAt) > this.#duMinRefreshMs;
							if (stale) {
								this.#refreshDu(value['path']);
							}
						}
						if (parent) {
							share.size = parent.refquota ?? ((parent.used ?? 0) + (parent.available ?? 0));
							share.free = parent.available ?? Math.max(share.size - share.alloc, 0);
						}
					}
					share.cap = (share.size > 0 ? share.alloc / share.size * 100 : 0);
				} catch (error) {
					console.error(`Error checking disk space for ${name}:`, error);
				}
				if (share.isTimeMachine && share.path) {
					try {
						const tm = new TimeMachine(share.path);
						share.timeMachine = await tm.getInfo();
					} catch (error) {
						share.timeMachine = null;
					}
				}
				return share;
			});
			this.setState('shares', await Promise.all(promises));
		} catch (error) {
			this.setState('shares', false);
		}
	}
}

module.exports = () => {
	return new ShareModule();
};

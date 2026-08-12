import { execa } from 'execa';

let scanning = null;

/** `zpool import` is the only way to see pools that aren't imported yet and it has no JSON output,
 * so its report is parsed by indentation:
 *
 *    pool: messier
 *      id: 1234567890
 *   state: ONLINE
 *  action: The pool can be imported using its name or numeric identifier.
 *  config:
 *
 *         messier          ONLINE      <- depth 0, the pool itself
 *           mirror-0       ONLINE      <- depth 1, a vdev
 *             nvme-eui.01  ONLINE      <- depth 2, a member drive
 */
const parseConfig = (lines, poolName) => {
	const vdevs = [];
	let baseIndent = null;
	for (const line of lines) {
		const [name, state] = line.trim().split(/\s+/);
		if (!name || name === poolName) {
			continue;
		}

		const indent = line.search(/\S/);
		if (baseIndent === null) {
			baseIndent = indent;
		}

		// Anything deeper than the first entry belongs to the vdev above it; a pool of bare drives has
		// no deeper level, so those drives become their own single-device entries.
		if (indent > baseIndent && vdevs.length > 0) {
			vdevs[vdevs.length - 1].devices.push({ name, state });
			continue;
		}

		vdevs.push({ name, state, devices: [] });
	}

	return vdevs;
};

const parseImportablePools = (output) => {
	const blocks = output.split(/^(?=\s*pool:\s)/m).filter((block) => { return /\s*pool:\s/.test(block); });
	return blocks.map((block) => {
		const lines = block.split('\n');
		const field = (name) => {
			return lines.find((line) => { return line.trim().startsWith(`${name}:`); })?.split(':').slice(1).join(':').trim() || null;
		};
		const configIndex = lines.findIndex((line) => { return line.trim().startsWith('config:'); });
		const name = field('pool');
		return {
			name,
			id: field('id'),
			state: field('state'),
			status: field('status'),
			action: field('action'),
			vdevs: (configIndex === -1 ? [] : parseConfig(lines.slice(configIndex + 1), name))
		};
	}).filter((pool) => { return Boolean(pool.name); });
};

/** Pools on the drives that aren't imported: what the setup wizard offers to adopt instead of
 * creating a new one. `false` means the scan itself failed, which is not the same as finding none. */
const scanImportablePools = async (module) => {
	if (scanning) {
		await scanning;
		return;
	}

	scanning = (async () => {
		try {
			// Having nothing to offer is a success: zpool exits 0 and reports it in prose, which parses
			// to an empty list. A throw here is a real failure — no zpool, not root, unreadable devices.
			const { stdout } = await execa('zpool', ['import']);
			module.setState('importable', parseImportablePools(stdout));
		} catch (error) {
			console.error('scanImportablePools:', error);
			module.setState('importable', false);
		}

		module.nsp.emit('host:storage:importable', module.getState('importable'));
		scanning = null;
	})();

	await scanning;
};

const register = (module) => {
	scanImportablePools(module);
};

const onConnection = (socket, module) => {
	socket.on('host:storage:importable:fetch', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		// Drives can settle after boot and disks get plugged in mid-wizard, so the answer is re-taken
		// on request rather than trusting the one from startup.
		scanImportablePools(module);
	});
};

export default {
	name: 'storage',
	register,
	onConnection
};

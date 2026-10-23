import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';

const SNAPSHOT_MAX_AGE_MS = 5000;

let socketSnapshot = {};

const isRegularFile = async (filePath) => {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch (error) {
		return false;
	}
};

const getOpenPaths = async (openFiles) => {
	const openPaths = new Map();
	await Promise.all(openFiles.map(async (file) => {
		if (!file.service_path || !await isRegularFile(path.join(file.service_path, file.filename ?? ''))) {
			return;
		}

		for (const open of Object.values(file.opens || {})) {
			const pid = open.server_id?.pid;
			openPaths.set(pid, new Set([...(openPaths.get(pid) || []), path.resolve(file.service_path)]));
		}
	}));
	return openPaths;
};

const getShares = async (module) => {
	module.eventEmitter.emit('shares:updated');
};

const getClients = async (module) => {
	try {
		const [sessionsOutput, sharesOutput, locksOutput, socketsOutput] = await Promise.all([
			execa('smbstatus', ['--json', '--brief']),
			execa('smbstatus', ['--json', '--shares']),
			execa('smbstatus', ['--json', '--locks']),
			execa('ss', ['-tinH', 'state', 'established', '( sport = :445 )'])
		]);
		const sessions = Object.values(JSON.parse(sessionsOutput.stdout || '{}').sessions || {});
		const tcons = Object.values(JSON.parse(sharesOutput.stdout || '{}').tcons || {});
		const openPaths = await getOpenPaths(Object.values(JSON.parse(locksOutput.stdout || '{}').open_files || {}));
		const sharePaths = new Map((module.getState('shares') || []).map((share) => { return [share.name?.toLowerCase(), (share.path ? path.resolve(share.path) : null)]; }));
		const now = Date.now();
		const sockets = readSockets(socketsOutput.stdout);
		const rates = {};
		const snapshot = {};
		for (const [peer, totals] of Object.entries(sockets)) {
			const previous = socketSnapshot[peer];
			const elapsed = (previous && now - previous.time <= SNAPSHOT_MAX_AGE_MS ? (now - previous.time) / 1000 : 0);
			rates[peer] = {
				rx: (elapsed > 0 ? Math.max(0, (totals.rx - previous.rx) / elapsed) : 0),
				tx: (elapsed > 0 ? Math.max(0, (totals.tx - previous.tx) / elapsed) : 0)
			};
			snapshot[peer] = { ...totals, time: now };
		}
		socketSnapshot = snapshot;

		const clients = sessions.map((session) => {
			const peers = Object.values(session.channels || {}).map((channel) => { return addressOf(channel.remote_address); });
			const sessionTcons = tcons.filter((tcon) => { return tcon.session_id === session.session_id && tcon.service?.toLowerCase() !== 'ipc$'; });
			const shares = [...new Set(sessionTcons.map((tcon) => { return tcon.service; }))];
			const activeShares = shares.filter((share) => {
				const sharePath = sharePaths.get(share?.toLowerCase());
				return sharePath && sessionTcons.some((tcon) => { return openPaths.get(tcon.server_id?.pid)?.has(sharePath); });
			});
			return {
				id: session.session_id,
				username: session.username,
				address: session.remote_machine,
				shares,
				activeShares,
				rx: peers.reduce((total, peer) => { return total + (rates[peer]?.rx ?? 0); }, 0),
				tx: peers.reduce((total, peer) => { return total + (rates[peer]?.tx ?? 0); }, 0)
			};
		});
		module.setState('clients', clients);
	} catch (error) {
		module.setState('clients', false);
	}
	module.emitState('clients');

	function addressOf(value) {
		return String(value || '').replace(/^ipv[46]:/, '').replace(/^\[?(?:::ffff:)?([^\]]*?)\]?(:\d+)$/, '$1$2').toLowerCase();
	}

	function readSockets(output) {
		const sockets = {};
		let peer = null;
		for (const line of String(output || '').split('\n')) {
			if (!line.trim()) {
				continue;
			}

			if (!/^\s/.test(line)) {
				peer = addressOf(line.trim().split(/\s+/).at(-1));
				continue;
			}

			if (peer) {
				const sent = /bytes_acked:(\d+)/.exec(line);
				const received = /bytes_received:(\d+)/.exec(line);
				sockets[peer] = { rx: Number(received?.[1] ?? 0), tx: Number(sent?.[1] ?? 0) };
				peer = null;
			}
		}
		return sockets;
	}
};

export default {
	name: 'polling',
	pollers: [
		{ run: getShares, interval: 60000 },
		{ run: getClients, interval: 2000, audience: 'admin' }
	]
};

import { execa } from 'execa';

const SNAPSHOT_MAX_AGE_MS = 5000;

let socketSnapshot = {};

const getShares = async (module) => {
	module.eventEmitter.emit('shares:updated');
};

const getClients = async (module) => {
	try {
		const [sessionsOutput, sharesOutput, socketsOutput] = await Promise.all([
			execa('smbstatus', ['--json', '--brief']),
			execa('smbstatus', ['--json', '--shares']),
			execa('ss', ['-tinH', 'state', 'established', '( sport = :445 )'])
		]);
		const sessions = Object.values(JSON.parse(sessionsOutput.stdout || '{}').sessions || {});
		const tcons = Object.values(JSON.parse(sharesOutput.stdout || '{}').tcons || {});
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
			const shares = [...new Set(tcons
				.filter((tcon) => { return tcon.session_id === session.session_id && tcon.service?.toLowerCase() !== 'ipc$'; })
				.map((tcon) => { return tcon.service; }))];
			return {
				id: session.session_id,
				username: session.username,
				address: session.remote_machine,
				shares,
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

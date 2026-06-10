import fs from 'fs';
import path from 'path';

const getNextcloudPaths = () => {
	const DATA = '/messier/apps/nextcloud/data';
	const GROUP_FOLDERS = '__groupfolders';
	const SKIP_ENTRIES = ['files_external'];

	const isInternal = (name) => {
		return name.startsWith('appdata_') || name.startsWith('.') || SKIP_ENTRIES.includes(name);
	};

	let entries;
	try {
		entries = fs.readdirSync(DATA, { withFileTypes: true });
	} catch {
		return [];
	}

	const paths = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		if (isInternal(entry.name)) {
			continue;
		}

		if (entry.name === GROUP_FOLDERS) {
			let groupEntries;
			try {
				groupEntries = fs.readdirSync(path.join(DATA, GROUP_FOLDERS), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const groupEntry of groupEntries) {
				if (!groupEntry.isDirectory() || !/^\d+$/.test(groupEntry.name)) {
					continue;
				}

				const groupPath = path.join(DATA, GROUP_FOLDERS, groupEntry.name, 'files');
				if (fs.existsSync(groupPath)) {
					paths.push(groupPath);
				}
			}
		} else {
			const userPath = path.join(DATA, entry.name, 'files');
			if (fs.existsSync(userPath)) {
				paths.push(userPath);
			}
		}
	}

	return paths;
};

const getDownloadsPath = () => {
	const DOWNLOADS = '/downloads';
	return (fs.existsSync(DOWNLOADS) ? [DOWNLOADS] : []);
};

const getCustomPaths = () => {
	return [
		...getNextcloudPaths(),
		...getDownloadsPath()
	];
};

const onConnection = (socket) => {
	socket.on('share:paths:custom', () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		socket.emit('share:paths:custom', getCustomPaths());
	});
};

export default {
	name: 'custom_paths',
	onConnection
};

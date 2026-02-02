const fs = require('fs').promises;
const path = require('path');
const plist = require('plist');

class TimeMachine {
	#backupPath;

	constructor(backupPath) {
		this.#backupPath = backupPath;
	}

	static async getMachines(backupPath) {
		try {
			const entries = await fs.readdir(backupPath, { withFileTypes: true });
			return entries
				.filter((entry) => {
					return entry.isDirectory() &&
						(entry.name.endsWith('.sparsebundle') || entry.name.endsWith('.backupbundle'));
				})
				.map((entry) => {
					return entry.name;
				})
				.filter((name) => {
					return name !== 'lost+found';
				})
				.map((name) => {
					const machineDir = path.join(backupPath, name);
					return {
						name,
						snapshotHistoryPath: path.join(machineDir, 'com.apple.TimeMachine.SnapshotHistory.plist')
					};
				});
		} catch {
			return [];
		}
	}

	/**
	 * Build full Time Machine backup structure for the share
	 * Returns machines with snapshots
	 */
	async getInfo() {
		try {
			const machines = await TimeMachine.getMachines(this.#backupPath);
			const info = await Promise.all(
				machines.map(async (machine) => {
					const snapshots = await this.#getSnapshots(machine.snapshotHistoryPath);
					const machineInfo = {
						name: machine.name,
						snapshots: snapshots.map((snapshot) => {
							return {
								name: snapshot.name,
								createdAt: snapshot.createdAt
							};
						})
					};
					return machineInfo;
				})
			);
			return info;
		} catch (error) {
			return [];
		}
	}

	async #readPlist(filepath) {
		try {
			const content = await fs.readFile(filepath, 'utf8');
			return plist.parse(content);
		} catch {
			return null;
		}
	}

	async #getSnapshots(snapshotHistoryPath) {
		try {
			const snapshotData = await this.#readPlist(snapshotHistoryPath);
			if (!snapshotData?.Snapshots) {
				return [];
			}

			return snapshotData.Snapshots.map((snapshot) => {
				const completionDate = new Date(snapshot['com.apple.backupd.SnapshotCompletionDate']);
				return {
					name: snapshot['com.apple.backupd.SnapshotName'],
					createdAt: completionDate
				};
			});
		} catch {
			return [];
		}
	}
}

module.exports = TimeMachine;

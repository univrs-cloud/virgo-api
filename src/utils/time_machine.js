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
						resultsPath: path.join(machineDir, 'com.apple.TimeMachine.Results.plist'),
						snapshotHistoryPath: path.join(machineDir, 'com.apple.TimeMachine.SnapshotHistory.plist')
					};
				});
		} catch {
			return [];
		}
	}

	/**
	 * Build full Time Machine backup structure for the share
	 * Returns machines with snapshots, sizes, progress
	 */
	async getInfo() {
		try {
			const machines = await TimeMachine.getMachines(this.#backupPath);
			const info = await Promise.all(
				machines.map(async (machine) => {
					const [snapshots, status] = await Promise.all([
						this.#getSnapshots(machine.snapshotHistoryPath),
						this.#getStatus(machine.resultsPath)
					]);

					const machineInfo = {
						name: machine.name,
						snapshots: snapshots.map((snapshot) => {
							return {
								name: snapshot.name,
								createdAt: snapshot.createdAt
							};
						})
					};

					if (status) {
						machineInfo.status = status;
					}

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

	async #getStatus(resultsPath) {
		try {
			const data = await this.#readPlist(resultsPath);
			if (!data) {
				return null;
			}

			const result = {
				running: data.Running ?? false,
				bytesUsed: data.BytesUsed || 0,
				bytesAvailable: data.BytesAvailable || 0
			};

			const progressData = data.Progress ?? data;
			if (progressData && (progressData.Percent !== undefined || progressData.bytes !== undefined)) {
				result.progress = {
					percent: progressData.Percent ?? 0,
					bytes: progressData.bytes || 0,
					totalBytes: progressData.totalBytes || 0,
					files: progressData.files || 0,
					totalFiles: progressData.totalFiles || 0,
					timeRemaining: progressData.TimeRemaining ?? 0
				};
			}
			return result;
		} catch {
			return null;
		}
	}
}

module.exports = TimeMachine;

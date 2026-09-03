import fs from 'fs/promises';
import { execa } from 'execa';
import * as yaml from 'js-yaml';
import linuxSysUser from 'linux-sys-user';
import BaseModule from '../base.js';

const linuxUser = linuxSysUser.promise();

class UserModule extends BaseModule {
	#autheliaUsersFile = '/messier/apps/authelia/config/users.yml';
	#cost = 12;

	constructor() {
		super('user');

		(async () => {
			await this.#loadUsers();
			this.#emitUsers();
		})();
		
		this.eventEmitter
			.on('users:updated', async () => {
				await this.#loadUsers();
				this.#emitUsers();
			});
	}

	get autheliaUsersFile() {
		return this.#autheliaUsersFile;
	}

	get cost() {
		return this.#cost;
	}

	onConnection(socket) {
		if (!this.getState('users')) {
			return;
		}

		this.#emitUsersToSocket(socket);
	}

	async setSambaUserPassword(username, password) {
		try {
			const proc = execa('smbpasswd', ['-s', '-a', username]);
			proc.stdin.write(`${password}\n${password}\n`);
			proc.stdin.end();
			await proc;
		} catch (error) {
			console.error(error);
		}
	}

	async toggleAutheliaUserLock(username, status) {
		const fileContents = await fs.readFile(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
		let autheliaUsersConfig = yaml.load(fileContents);
		if (autheliaUsersConfig.users && autheliaUsersConfig.users[username]) {
			autheliaUsersConfig.users[username].disabled = status;
			const updatedYaml = yaml.dump(autheliaUsersConfig, { indent: 2 });
			await fs.writeFile(this.autheliaUsersFile, updatedYaml, 'utf8');
		}
	}

	async #loadUsers() {
		try {
			// Authelia lives on the pool and is installed during setup, so its user file is missing on a
			// fresh node — and unreadable whenever the pool is not mounted. The system accounts are the
			// truth about who exists either way, so a missing file costs the enrichment, not the list.
			let autheliaUsersConfig = null;
			try {
				const fileContents = await fs.readFile(this.autheliaUsersFile, { encoding: 'utf8', flag: 'r' });
				autheliaUsersConfig = yaml.load(fileContents);
			} catch (error) {}
			let users = await linuxUser.getUsers();
			let groups = await linuxUser.getGroups();
			users = users
				.filter((user) => {
					return user.uid >= 1000 && user.uid <= 10000;
				})
				.map((user) => {
					user.isOwner = (user.uid === 1000);
					user.isDisabled = false;
					user.groups = groups.filter((group) => { return group.gid === user.gid });
					user.email = null;
					const autheliaUser = autheliaUsersConfig?.users?.[user.username];
					if (autheliaUser) {
						user.isDisabled = autheliaUser.disabled;
						user.groups = [...user.groups, ...(autheliaUser.groups || [])];
						user.email = autheliaUser.email;
					}
					return user;
				});
			this.setState('users', users);
		} catch (error) {
			this.setState('users', false);
		}
	}

	#emitUsers() {
		if (!this.getState('users')) {
			return;
		}

		this.nsp.sockets.forEach((socket) => {
			this.#emitUsersToSocket(socket);
		});
	}

	#emitUsersToSocket(socket) {
		if (!socket.isAuthenticated) {
			return;
		}

		if (!socket.isAdmin) {
			socket.emit('users', this.toArray(this.getState('users')).filter((user) => { return user.username === socket.username; }));
			return;
		}

		socket.emit('users', this.getState('users'));
	}
}

export default () => {
	return new UserModule();
};

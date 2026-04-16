'use strict';

const { InvalidArgumentError, Option } = require('commander');
const { Queue } = require('bullmq');
const config = require('../config');
const { getQueueName } = require('../src/queues');

const enqueueHostJob = async (jobName, data, doneMessage) => {
	const queueName = getQueueName('host');
	const connection = {
		host: config.redis.host,
		port: config.redis.port
	};
	const queue = new Queue(queueName, { connection });
	try {
		await queue.add(jobName, data);
		console.log(doneMessage);
	} catch (err) {
		console.error(err);
		process.exitCode = 1;
	} finally {
		await queue.close();
	}
};

const queueHostNetworkIdentifierJob = async (opts) => {
	await enqueueHostJob(
		'host:network:identifier:update',
		{
			config: {
				hostname: opts.hostname,
				domainName: opts.domain
			},
			username: process.env.USER || 'cli'
		},
		'Hostname and DNS search domain update started.'
	);
};

const queueHostNetworkInterfaceJob = async (opts) => {
	const { method } = opts;
	const config = { method };
	if (method === 'manual') {
		if (opts.address === undefined || opts.prefix === undefined || opts.gateway === undefined) {
			console.error('--method manual requires --address, --prefix, and --gateway.');
			process.exitCode = 1;
			return;
		}
		config.ipAddress = opts.address;
		config.netmask = String(opts.prefix);
		config.gateway = opts.gateway;
	}
	await enqueueHostJob(
		'host:network:interface:update',
		{
			config,
			username: process.env.USER || 'cli'
		},
		'Network interface update started.'
	);
};

const register = (program) => {
	const networkCmd = program
		.command('network')
		.description('Network settings');

	const identifierCmd = networkCmd
		.command('identifier')
		.description('Hostname and DNS search domain');

	identifierCmd
		.command('update')
		.description('Set hostname and DNS search domain')
		.requiredOption('--hostname <name>', 'Short hostname')
		.requiredOption('--domain <name>', 'DNS search domain')
		.action(queueHostNetworkIdentifierJob);

	const interfaceCmd = networkCmd
		.command('interface')
		.description('IPv4 settings for the bonded interface');

	interfaceCmd
		.command('update')
		.description('Configure IPv4 (DHCP or static address)')
		.addOption(
			new Option('--method <mode>', 'DHCP (auto) or static IP (manual)')
				.choices(['auto', 'manual'])
				.makeOptionMandatory()
		)
		.option('--address <ip>', 'IPv4 address (required with --method manual)')
		.option('--prefix <n>', 'CIDR prefix length (required with --method manual)', (value) => {
			const n = Number.parseInt(value, 10);
			if (Number.isNaN(n)) {
				throw new InvalidArgumentError('Not a valid integer.');
			}
			return n;
		})
		.option('--gateway <ip>', 'Default gateway (required with --method manual)')
		.action(queueHostNetworkInterfaceJob);
};

module.exports = register;

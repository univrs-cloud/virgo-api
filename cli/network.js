import { InvalidArgumentError, Option } from 'commander';
import { Queue } from 'bullmq';
import config from '../config.js';
import { getQueueName } from '../src/queues.js';

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
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		await queue.close();
	}
};

const queueHostNetworkIdentifierJob = async (options) => {
	await enqueueHostJob(
		'host:network:identifier:update',
		{
			config: {
				hostname: options.hostname,
				domainName: options.domain
			},
			username: process.env.USER || 'cli'
		},
		'Hostname and DNS search domain update started.'
	);
};

const queueHostNetworkInterfaceJob = async (options) => {
	const interfaceConfig = buildInterfaceConfig(options);
	if (interfaceConfig === null) {
		return;
	}
	await enqueueHostJob(
		'host:network:interface:update',
		{
			config: interfaceConfig,
			username: process.env.USER || 'cli'
		},
		'Network interface update started.'
	);

	function buildInterfaceConfig(options) {
		const { method } = options;
		const config = { method };
		if (method === 'manual') {
			if (options.address === undefined || options.prefix === undefined || options.gateway === undefined) {
				console.error('--method manual requires --address, --prefix, and --gateway.');
				process.exitCode = 1;
				return null;
			}
			config.ipAddress = options.address;
			config.netmask = String(options.prefix);
			config.gateway = options.gateway;
		}
		return config;
	}
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
		.option('--prefix <n>', 'CIDR prefix length (required with --method manual)', parsePrefixOption)
		.option('--gateway <ip>', 'Default gateway (required with --method manual)')
		.action(queueHostNetworkInterfaceJob);

	function parsePrefixOption(value) {
		const n = Number.parseInt(value, 10);
		if (Number.isNaN(n)) {
			throw new InvalidArgumentError('Not a valid integer.');
		}
		return n;
	}
};

export default register;

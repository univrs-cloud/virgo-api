import crypto from 'crypto';
import fs from 'fs/promises';

const MACHINE_ID_FILE = '/etc/machine-id';
const ID_NAMESPACE = 'univrs:node-discovery';
const ID_LENGTH = 16;
const ID_PATTERN = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`);

let cachedNodeId = null;

const getNodeId = async () => {
	if (cachedNodeId) {
		return cachedNodeId;
	}

	const machineId = (await fs.readFile(MACHINE_ID_FILE, 'utf8')).trim();

	if (!machineId) {
		throw new Error(`${MACHINE_ID_FILE} is empty`);
	}

	cachedNodeId = crypto
		.createHash('sha256')
		.update(`${ID_NAMESPACE}:${machineId}`)
		.digest('hex')
		.slice(0, ID_LENGTH);

	return cachedNodeId;
};

const isNodeId = (value) => {
	return typeof value === 'string' && ID_PATTERN.test(value);
};

export {
	getNodeId,
	isNodeId
};

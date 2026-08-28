import { execa } from 'execa';

const BOND_NAME = 'bond0';

const getDefaultInterfaceName = async () => {
	try {
		const { stdout: routeOutput } = await execa('ip', ['-j', 'route', 'show', 'default']);
		return JSON.parse(routeOutput || '[]')[0]?.dev || null;
	} catch (error) {
		return null;
	}
};

/** Whether another host already answers for an address, asked the way a host asks before claiming one:
 * an ARP probe sent from 0.0.0.0, so a reply can only come from something that already owns it. Being
 * link-layer, this reaches the address whatever subnet it is in. Exit 1 is that reply. Any other
 * failure answers nothing — a node with no lease has no interface to probe from, which is exactly
 * the node that needs a static address — so that case is `null`: unknown, not free. */
const isAddressInUse = async (ipAddress) => {
	const device = await getDefaultInterfaceName() || BOND_NAME;
	try {
		await execa('arping', ['-D', '-q', '-c', '2', '-w', '3', '-I', device, ipAddress]);
		return false;
	} catch (error) {
		if (error.exitCode === 1) {
			return true;
		}

		console.warn(`Could not check whether ${ipAddress} is in use: ${error.shortMessage || error.message}`);
		return null;
	}
};

const getAddresses = async () => {
	try {
		const { stdout } = await execa('ip', ['-j', 'addr', 'show']);
		return JSON.parse(stdout || '[]');
	} catch (error) {
		return [];
	}
};

const holdsAddress = async (address) => {
	return (await getAddresses()).some((iface) => {
		return iface.addr_info?.some((info) => { return info.local === address; });
	});
};

export {
	BOND_NAME,
	getDefaultInterfaceName,
	isAddressInUse,
	getAddresses,
	holdsAddress
};

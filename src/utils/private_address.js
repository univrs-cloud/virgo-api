/**
 * Whether an address belongs to the premises the node sits on — loopback, the RFC1918 ranges, link
 * local and IPv6 unique local. Not a policy: which networks are allowed to see a node without signing
 * in is Authelia's to say. This is the answer for when Authelia cannot be asked.
 */

const PRIVATE_PATTERNS = [
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
	/^::1$/,
	/^f[cd]/i,
	/^fe80:/i
];

const isPrivateAddress = (address) => {
	const normalized = (address || '').replace(/^::ffff:/i, '');
	return PRIVATE_PATTERNS.some((pattern) => { return pattern.test(normalized); });
};

export {
	isPrivateAddress
};

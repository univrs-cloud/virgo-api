import crypto from 'crypto';

/**
 * What the fleet's proxy shows when it opens a connection to this node's own namespaces, so they can
 * tell it apart from anything else that can reach the port. Both ends are this process: it is made
 * when the process starts, never written down, never sent anywhere but to itself, and replaced by a
 * new one the next time the service runs. Nothing else on the machine can produce it without being
 * able to read this process's memory, which takes more privilege than it would gain.
 */

const secret = crypto.randomBytes(32).toString('hex');

const getSecret = () => {
	return secret;
};

/** Compared in constant time: the value is a fixed length, and a comparison that stops at the first
 * difference is a comparison that can be measured. */
const matches = (candidate) => {
	if (typeof candidate !== 'string' || candidate.length !== secret.length) {
		return false;
	}

	return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(secret));
};

export {
	getSecret,
	matches
};

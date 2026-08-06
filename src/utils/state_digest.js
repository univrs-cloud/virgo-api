import crypto from 'crypto';

// Key order is not guaranteed across polls (objects rebuilt from Maps, camelcaseKeys, JSON.parse), so
// canonicalise before hashing or identical data reads as changed.
const canonicalize = (value, sortArrays) => {
	if (value === null || typeof value !== 'object') {
		return value;
	}

	if (Array.isArray(value)) {
		const items = value.map((item) => { return canonicalize(item, sortArrays); });
		return (sortArrays ? items.sort((first, second) => { return JSON.stringify(first).localeCompare(JSON.stringify(second)); }) : items);
	}

	return Object.keys(value).sort().reduce((accumulator, key) => {
		accumulator[key] = canonicalize(value[key], sortArrays);
		return accumulator;
	}, {});
};

/**
 * @param {*} payload - The payload to digest
 * @param {object} [options]
 * @param {boolean} [options.sortArrays] - Treat every array as a set. Needed for payloads the source builds
 *   by walking a hash map: the Docker API does this for ports and mounts, so Go's randomised map iteration
 *   hands them back in a different order on nearly every call even though nothing has changed.
 */
const digest = (payload, { sortArrays = false } = {}) => {
	return crypto.createHash('sha1').update(JSON.stringify(canonicalize(payload, sortArrays)) ?? 'undefined').digest('base64');
};

export { digest };

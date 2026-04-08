/**
 * Trust remote-user headers only when the TCP peer matches built-in defaults or
 * entries added via add() from configuration key `trustedProxies` (merged with defaults).
 *
 * Each rule is either an exact IP (after ::ffff: stripping) or an IPv4 prefix
 * ending with "." (e.g. "10.0." matches 10.0.x.x).
 */

const DEFAULT_TRUSTED_PROXY_RULES = ['127.0.0.1', '::1', '172.30.'];

/** @type {string[]} */
let configuredProxyRules = [];

function normalizeRemoteAddress(remoteAddress) {
	if (!remoteAddress || typeof remoteAddress !== 'string') {
		return null;
	}

	return remoteAddress.replace(/^::ffff:/i, '');
}

function matchesTrustedProxyRule(normalized, rule) {
	if (!rule || typeof rule !== 'string') {
		return false;
	}
	const r = rule.trim();
	if (!r) {
		return false;
	}
	if (normalized === r) {
		return true;
	}
	if (r.endsWith('.') && !normalized.includes(':')) {
		return normalized.startsWith(r);
	}
	return false;
}

function clear() {
	configuredProxyRules = [];
}

/**
 * @param {unknown} rule
 */
function add(rule) {
	if (typeof rule !== 'string') {
		return;
	}
	const r = rule.trim();
	if (r) {
		configuredProxyRules.push(r);
	}
}

function isFromTrustedProxy(remoteAddress) {
	const normalized = normalizeRemoteAddress(remoteAddress);
	if (!normalized) {
		return false;
	}

	const rules = [...DEFAULT_TRUSTED_PROXY_RULES, ...configuredProxyRules];
	return rules.some((rule) => {
		return matchesTrustedProxyRule(normalized, rule);
	});
}

module.exports = {
	isFromTrustedProxy,
	clear,
	add
};

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

/**
 * Replaces the configured rules in a single assignment. Emptying the list and refilling it entry by
 * entry would leave a window in which a reload had already discarded a proxy it was about to add back,
 * and a request arriving in that window would be judged against an incomplete list.
 *
 * @param {unknown} rules
 */
function set(rules) {
	configuredProxyRules = (Array.isArray(rules) ? rules : [])
		.filter((rule) => { return typeof rule === 'string'; })
		.map((rule) => { return rule.trim(); })
		.filter(Boolean);
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

export {
	isFromTrustedProxy,
	set
};

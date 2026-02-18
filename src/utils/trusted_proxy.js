/**
 * True if the request came from the trusted auth proxy (e.g. Traefik + Authelia).
 * Only then do we trust remote-user and set the account cookie / allow Socket auth.
 * Trusts loopback (same-host proxy) and 172.30.* (typical Docker proxy network).
 */
function isFromTrustedProxy(remoteAddress) {
	if (!remoteAddress || typeof remoteAddress !== 'string') {
		return false;
	}

	const normalized = remoteAddress.replace(/^::ffff:/i, '');
	return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('172.30.');
}

module.exports = { isFromTrustedProxy };

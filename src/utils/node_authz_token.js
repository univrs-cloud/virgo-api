import crypto from 'crypto';

const MAX_CLOCK_SKEW_MS = 30_000;

const timingSafeEquals = (left, right) => {
	const a = Buffer.from(String(left ?? ''), 'utf8');
	const b = Buffer.from(String(right ?? ''), 'utf8');
	if (a.length !== b.length || !a.length) {
		return false;
	}

	return crypto.timingSafeEqual(a, b);
};

const parsePayload = (encoded) => {
	try {
		return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch (error) {
		return null;
	}
};

const verifyNodeSessionToken = (token, { nodeToken, nodeId, sessionId } = {}) => {
	if (typeof token !== 'string' || !nodeToken) {
		return null;
	}

	const parts = token.split('.');
	if (parts.length !== 2) {
		return null;
	}

	const [encodedPayload, signature] = parts;
	const expected = crypto.createHmac('sha256', nodeToken).update(encodedPayload).digest('base64url');
	if (!timingSafeEquals(signature, expected)) {
		return null;
	}

	const claims = parsePayload(encodedPayload);
	if (!claims || claims.transport !== 'webrtc') {
		return null;
	}

	if (claims.nodeId !== nodeId || claims.sid !== sessionId) {
		return null;
	}

	const now = Date.now();
	if (!Number.isFinite(claims.exp) || now > claims.exp + MAX_CLOCK_SKEW_MS) {
		return null;
	}

	if (Number.isFinite(claims.iat) && now + MAX_CLOCK_SKEW_MS < claims.iat) {
		return null;
	}

	return claims;
};

export {
	verifyNodeSessionToken,
	timingSafeEquals
};

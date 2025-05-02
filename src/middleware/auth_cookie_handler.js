/**
 * Middleware to handle authentication cookies based on request headers.
 */
module.exports = (req, res, next) => {
	const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 184;
	const cookieOptions = {
		domain: req.hostname,
		encode: String,
		httpOnly: false,
		secure: true,
		sameSite: 'lax',
		maxAge: SIX_MONTHS_MS
	};
	if (req.headers['remote-user']) {
		let account = {
			name: req.headers['remote-name'],
			user: req.headers['remote-user'],
			email: req.headers['remote-email'],
			groups: req.headers['remote-groups']?.split(',')
		};
		const serializedAccount = Buffer.from(JSON.stringify(account)).toString('base64');
		res.cookie('account', serializedAccount, cookieOptions);
	} else {
		// Clear the cookie if remote-user header is not present
		res.cookie('account', '', cookieOptions);
	}
	res.header('Access-Control-Allow-Origin', '*');
	next();
};

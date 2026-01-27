const express = require('express');
const { URL } = require('url');
const { Agent } = require('undici');
const docker = require('../utils/docker_client');

const router = express.Router();

// Cache resolved Authelia URL
let cachedAutheliaURL = null;

// Resolve Authelia URL dynamically from Docker container
async function resolveAutheliaURL() {
	// Return cached URL if available
	if (cachedAutheliaURL) {
		return cachedAutheliaURL;
	}

	// Try to find Authelia container IP via Docker API
	try {
		const containers = await docker.listContainers({ all: true });
		const autheliaContainer = containers.find(container => {
			// Match by image name (most reliable)
			const image = container.Image || '';
			if (image.includes('authelia/authelia')) {
				return true;
			}
		});
		
		if (autheliaContainer) {
			const container = docker.getContainer(autheliaContainer.Id);
			const info = await container.inspect();
			
			// Since 'internal' network is marked internal:true, host cannot access it directly
			// Try to use Traefik URL by reading DOMAIN from container environment
			const envVars = info.Config?.Env || [];
			const domainEnv = envVars.find(env => env.startsWith('DOMAIN='));
			if (domainEnv) {
				const domain = domainEnv.split('=')[1];
				cachedAutheliaURL = `https://auth.${domain}`;
				return cachedAutheliaURL;
			}
		}
	} catch (error) {
		console.warn('Failed to resolve Authelia container address:', error.message);
	}
	
	// If resolution fails, return null to trigger error handling
	return null;
}

async function proxyToAuthelia(path, options = {}) {
	const url = await resolveAutheliaURL();
	if (!url) {
		throw new Error('Failed to resolve Authelia URL. Ensure Authelia container is running and accessible.');
	}
	const autheliaURL = new URL(path, url);

	const fetchOptions = {
		method: options.method || 'GET',
		headers: {
			'Content-Type': 'application/json',
			...options.headers
		},
		dispatcher: new Agent({
			connect: {
				rejectUnauthorized: false
			}
		})
	};

	if (options.body) {
		fetchOptions.body = typeof options.body === 'string' 
			? options.body 
			: JSON.stringify(options.body);
	}

	const response = await fetch(autheliaURL, fetchOptions);
	const jsonData = await response.json();

	return {
		statusCode: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		data: jsonData
	};
}

// Login
router.post('/login', async (req, res) => {
	try {
		const { username, password, targetURL, keepMeLoggedIn } = req.body;

		if (!username || !password) {
			return res.status(400).json({
				status: 'KO',
				message: 'Username and password are required'
			});
		}

		const cookies = req.headers.cookie || '';

		const response = await proxyToAuthelia('/api/firstfactor', {
			method: 'POST',
			headers: { Cookie: cookies },
			body: {
				username,
				password,
				targetURL: targetURL || '/',
				keepMeLoggedIn: keepMeLoggedIn || false
			}
		});

		// Forward Set-Cookie headers to browser
		if (response.headers['set-cookie']) {
			response.headers['set-cookie'].forEach(cookie => {
				res.append('Set-Cookie', cookie);
			});
		}

		if (response.statusCode === 200 && response.data.status === 'OK') {
			// Get auth state
			const stateResponse = await proxyToAuthelia('/api/state', {
				method: 'GET',
				headers: { Cookie: response.headers['set-cookie']?.[0] || cookies }
			});

			res.json({
				status: 'OK',
				data: {
					redirect: response.data.data?.redirect,
					requires2FA: stateResponse.data?.data?.authentication_level === 1,
					state: stateResponse.data
				}
			});
		} else {
			res.status(response.statusCode).json({
				status: 'KO',
				message: response.data.message || 'Authentication failed'
			});
		}
	} catch (error) {
		console.error('Login error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'Authentication failed'
		});
	}
});

// Logout
router.post('/logout', async (req, res) => {
	try {
		const { targetURL } = req.body;
		const cookies = req.headers.cookie || '';

		const response = await proxyToAuthelia('/api/logout', {
			method: 'POST',
			headers: { Cookie: cookies },
			body: { targetURL: targetURL || '/' }
		});

		// Forward Set-Cookie headers
		if (response.headers['set-cookie']) {
			response.headers['set-cookie'].forEach(cookie => {
				res.append('Set-Cookie', cookie);
			});
		}

		// Get updated state
		const stateResponse = await proxyToAuthelia('/api/state', {
			method: 'GET',
			headers: { Cookie: response.headers['set-cookie']?.[0] || cookies }
		});

		res.json({
			...response.data,
			state: stateResponse.data
		});
	} catch (error) {
		console.error('Logout error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'Logout failed'
		});
	}
});

// Get auth state
router.get('/state', async (req, res) => {
	try {
		const cookies = req.headers.cookie || '';
		const response = await proxyToAuthelia('/api/state', {
			method: 'GET',
			headers: { Cookie: cookies }
		});

		res.json(response.data);
	} catch (error) {
		console.error('State check error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'Failed to check authentication state'
		});
	}
});

// Get configuration
router.get('/configuration', async (req, res) => {
	try {
		const cookies = req.headers.cookie || '';
		const response = await proxyToAuthelia('/api/configuration', {
			method: 'GET',
			headers: { Cookie: cookies }
		});

		res.json(response.data);
	} catch (error) {
		console.error('Configuration error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'Failed to get configuration'
		});
	}
});

// TOTP 2FA
router.post('/2fa/totp', async (req, res) => {
	try {
		const { token, targetURL } = req.body;

		if (!token) {
			return res.status(400).json({
				status: 'KO',
				message: 'TOTP token is required'
			});
		}

		const cookies = req.headers.cookie || '';

		const response = await proxyToAuthelia('/api/secondfactor/totp', {
			method: 'POST',
			headers: { Cookie: cookies },
			body: {
				token,
				targetURL: targetURL || '/'
			}
		});

		// Forward Set-Cookie headers
		if (response.headers['set-cookie']) {
			response.headers['set-cookie'].forEach(cookie => {
				res.append('Set-Cookie', cookie);
			});
		}

		// Get updated state
		const stateResponse = await proxyToAuthelia('/api/state', {
			method: 'GET',
			headers: { Cookie: response.headers['set-cookie']?.[0] || cookies }
		});

		res.json({
			...response.data,
			state: stateResponse.data
		});
	} catch (error) {
		console.error('TOTP verification error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'TOTP verification failed'
		});
	}
});

// WebAuthn start
router.get('/2fa/webauthn', async (req, res) => {
	try {
		const cookies = req.headers.cookie || '';
		const response = await proxyToAuthelia('/api/secondfactor/webauthn', {
			method: 'GET',
			headers: { Cookie: cookies }
		});

		res.json(response.data);
	} catch (error) {
		console.error('WebAuthn start error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'Failed to start WebAuthn authentication'
		});
	}
});

// WebAuthn complete
router.post('/2fa/webauthn', async (req, res) => {
	try {
		const { credential, targetURL } = req.body;

		if (!credential) {
			return res.status(400).json({
				status: 'KO',
				message: 'WebAuthn credential is required'
			});
		}

		const cookies = req.headers.cookie || '';

		const response = await proxyToAuthelia('/api/secondfactor/webauthn', {
			method: 'POST',
			headers: { Cookie: cookies },
			body: {
				...credential,
				targetURL: targetURL || '/'
			}
		});

		// Forward Set-Cookie headers
		if (response.headers['set-cookie']) {
			response.headers['set-cookie'].forEach(cookie => {
				res.append('Set-Cookie', cookie);
			});
		}

		// Get updated state
		const stateResponse = await proxyToAuthelia('/api/state', {
			method: 'GET',
			headers: { Cookie: response.headers['set-cookie']?.[0] || cookies }
		});

		res.json({
			...response.data,
			state: stateResponse.data
		});
	} catch (error) {
		console.error('WebAuthn verification error:', error);
		res.status(500).json({
			status: 'KO',
			message: 'WebAuthn verification failed'
		});
	}
});

module.exports = router;

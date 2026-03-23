const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const camelcaseKeys = require('camelcase-keys').default;
const docker = require('../../utils/docker_client');

const MANIFEST_ACCEPT = [
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
	'application/vnd.oci.image.manifest.v1+json'
].join(',');

const parseImageRef = (image) => {
	let remaining = image;
	let registry = 'registry-1.docker.io';

	// If the first path component contains a dot, colon, or is "localhost" it's a registry host
	const firstSlash = remaining.indexOf('/');
	if (firstSlash !== -1) {
		const firstPart = remaining.slice(0, firstSlash);
		if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
			registry = firstPart;
			remaining = remaining.slice(firstSlash + 1);
		}
	}

	// docker.io is an alias — the actual API lives at registry-1.docker.io
	if (registry === 'docker.io') {
		registry = 'registry-1.docker.io';
	}

	// Extract tag (last colon that is not part of a port)
	const lastColon = remaining.lastIndexOf(':');
	let tag = 'latest';
	let repoPath = remaining;
	if (lastColon !== -1 && !remaining.slice(lastColon + 1).includes('/')) {
		tag = remaining.slice(lastColon + 1);
		repoPath = remaining.slice(0, lastColon);
	}

	// Docker Hub official images require the library/ namespace
	if (registry === 'registry-1.docker.io' && !repoPath.includes('/')) {
		repoPath = `library/${repoPath}`;
	}

	return { registry, repoPath, tag };
};

/**
 * Fetches the manifest digest for an image using the standard Docker Registry v2
 * WWW-Authenticate challenge-response flow. Works with any public registry.
 * Returns null (silently) for private registries or images that require credentials.
 */
const getRegistryDigest = async (image) => {
	const { registry, repoPath, tag } = parseImageRef(image);
	const registryBase = `https://${registry}`;

	try {
		// Step 1: Challenge request — the registry tells us where to get a token
		const challengeResponse = await fetch(`${registryBase}/v2/`);
		let authHeader = null;

		if (challengeResponse.status === 401) {
			await challengeResponse.arrayBuffer().catch(() => {});
			const wwwAuth = challengeResponse.headers.get('WWW-Authenticate') || '';

			if (wwwAuth.toLowerCase().startsWith('basic')) {
				// Basic auth means credentials are required — private registry, skip
				return null;
			}

			if (wwwAuth.toLowerCase().startsWith('bearer')) {
				const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
				const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);
				if (!realmMatch) {
					throw new Error(`No realm in WWW-Authenticate header from ${registry}`);
				}

				const tokenUrl = new URL(realmMatch[1]);
				if (serviceMatch) {
					tokenUrl.searchParams.set('service', serviceMatch[1]);
				}
				tokenUrl.searchParams.set('scope', `repository:${repoPath}:pull`);

				const tokenResponse = await fetch(tokenUrl.toString());
				if (!tokenResponse.ok) {
					// Token request failed — likely a private repo, skip silently
					await tokenResponse.arrayBuffer().catch(() => {});
					return null;
				}
				const { token, access_token } = await tokenResponse.json();
				const resolved = token || access_token;
				if (!resolved) {
					return null;
				}
				authHeader = `Bearer ${resolved}`;
			}
		} else {
			await challengeResponse.arrayBuffer().catch(() => {});
		}

		// Step 2: HEAD the manifest — cheap, returns digest in response header
		const headers = { Accept: MANIFEST_ACCEPT };
		if (authHeader) {
			headers.Authorization = authHeader;
		}

		const manifestResponse = await fetch(`${registryBase}/v2/${repoPath}/manifests/${tag}`, {
			method: 'HEAD',
			headers,
		});

		if (manifestResponse.status === 429) {
			const retryAfter = manifestResponse.headers.get('Retry-After');
			console.warn(`Rate limited by registry for ${image}${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
			await manifestResponse.arrayBuffer().catch(() => {});
			return null;
		}

		if (manifestResponse.status === 401 || manifestResponse.status === 403) {
			// Private registry — skip silently
			await manifestResponse.arrayBuffer().catch(() => {});
			return null;
		}

		if (!manifestResponse.ok) {
			await manifestResponse.arrayBuffer().catch(() => {});
			throw new Error(`HTTP ${manifestResponse.status} fetching manifest for ${image}`);
		}

		return manifestResponse.headers.get('docker-content-digest');
	} catch (error) {
		console.warn(`Could not fetch digest for ${image}: ${error.message}`);
		return null;
	}
};

const checkForUpdates = async (module) => {
	const updates = [];
	let images = await docker.listImages({ all: true, digests: true });
	images = camelcaseKeys(images, { deep: true });
	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });

	// Map of imageId -> { imageName, localDigests, containerIds[] }
	// Keyed by imageId so containers running different pulled versions of the same image
	// name each get their own digest comparison rather than sharing the first one seen.
	const imageIdMap = new Map();

	for (const { id, imageId, image: imageName, labels } of containers) {
		const image = images.find((image) => { return image.id === imageId; });
		if (!Array.isArray(image?.repoDigests) || image.repoDigests.length === 0) {
			continue;
		}

		const localDigests = image.repoDigests.map((repoDigest) => { return repoDigest.split('@')[1] || null; });

		// Check compose file first — if image name has changed, no registry request needed
		let resolvedByCompose = false;
		try {
			const composeFilePath = labels?.comDockerComposeProjectConfigFiles || path.join(module.composeDir, labels?.comDockerComposeProject, 'docker-compose.yml');
			try {
				await fs.promises.access(composeFilePath);
			} catch (error) {
				// Compose file doesn't exist, skip image comparison and fall back to digest comparison
				throw error;
			}

			const composeFileContent = await fs.promises.readFile(composeFilePath, 'utf-8');
			const composeData = yaml.load(composeFileContent);
			const service = composeData?.services?.[labels?.comDockerComposeService];
			if (service?.image && imageName !== service.image) {
				updates.push({ containerId: id });
				resolvedByCompose = true;
			}
		} catch (error) {
			// If we can't read/parse compose file, fall back to digest comparison
		}

		if (resolvedByCompose) {
			continue;
		}

		if (!imageIdMap.has(imageId)) {
			imageIdMap.set(imageId, { imageName, localDigests, containerIds: [] });
		}
		imageIdMap.get(imageId).containerIds.push(id);
	}

	// Deduplicate registry requests by image name — one HTTP request per unique name
	const uniqueImageNames = [...new Set([...imageIdMap.values()].map((v) => { return v.imageName; }))];
	const results = await Promise.allSettled(
		uniqueImageNames.map((imageName) => { return getRegistryDigest(imageName); })
	);

	const registryDigestByName = new Map();
	for (let i = 0; i < uniqueImageNames.length; i++) {
		const result = results[i];
		if (result.status === 'fulfilled' && result.value) {
			registryDigestByName.set(uniqueImageNames[i], result.value);
		}
	}

	// Each imageId entry is compared independently — containers still on a stale image
	// are flagged even if another container has already pulled the latest version.
	for (const { imageName, localDigests, containerIds } of imageIdMap.values()) {
		const registryDigest = registryDigestByName.get(imageName);
		if (!registryDigest) {
			continue;
		}

		if (!localDigests.includes(registryDigest)) {
			for (const containerId of containerIds) {
				updates.push({ containerId });
			}
		}
	}

	module.setState('updates', updates);

	for (const socket of module.nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			socket.emit('app:updates', module.getState('updates'));
		}
	}
};

const fetchStackFiles = async (module) => {
	try {
		const composeDir = module.composeDir;

		// Check if compose directory exists
		try {
			await fs.promises.access(composeDir);
		} catch (error) {
			console.warn(`Compose directory ${composeDir} does not exist. Skipping compose files update.`);
			return;
		}

		// Get all installed applications from module state (configured)
		const configured = module.getState('configured') || [];
		const installedApps = configured.filter((item) => { return item.type === 'app'; });

		// Get templates from module state
		const templates = module.getState('templates') || [];

		// Update compose files for each installed app that has a template
		for (const app of installedApps) {
			const appName = app.name;
			const template = templates.find((template) => { return template.name === appName; });

			if (!template) {
				continue; // Skip if no template exists for this app
			}

			// Only update if template has repository information
			if (!template.repository?.url || !template.repository?.stackfile) {
				continue;
			}

			try {
				const composeFilePath = path.join(composeDir, appName, 'docker-compose.yml');

				// Check if docker-compose.yml file exists
				try {
					await fs.promises.access(composeFilePath);
				} catch (error) {
					// File doesn't exist, skip
					continue;
				}

				// Download the template
				const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
				if (!response.ok) {
					console.warn(`Failed to download template for ${appName}: HTTP ${response.status}`);
					continue;
				}

				const stack = await response.text();

				// Replace the docker-compose.yml file
				await fs.promises.writeFile(composeFilePath, stack, 'utf-8');
				console.log(`Updated docker-compose.yml for ${appName}`);
			} catch (error) {
				console.warn(`Error updating compose file for ${appName}:`, error.message);
			}
		}
	} catch (error) {
		console.error(`Error updating compose files:`, error);
	}
};

const register = (module) => {
	checkForUpdates(module);

	// Schedule updates checker to run daily at midnight
	module.addJobSchedule(
		'app:updates:check',
		{ pattern: '0 0 0 * * *' }
	);

	// Schedule templates fetcher to run every hour at minute 1
	module.addJobSchedule(
		'app:templates:fetch',
		{ pattern: '0 1 * * * *' }
	);

	// Schedule compose files updater to run daily at midnight
	module.addJobSchedule(
		'app:stackfiles:fetch',
		{ pattern: '0 0 0 * * *' }
	);
};

const onConnection = (socket, module) => {
	if (socket.isAuthenticated && socket.isAdmin) {
		if (module.getState('updates')) {
			socket.emit('app:updates', module.getState('updates'));
		}
	}
};

module.exports = {
	name: 'scheduled',
	register,
	onConnection,
	jobs: {
		'app:updates:check': async (job, module) => {
			await checkForUpdates(module);
			return ``;
		},
		'app:templates:fetch': async (job, module) => {
			module.eventEmitter.emit('app:templates:fetch');
			return ``;
		},
		'app:stackfiles:fetch': async (job, module) => {
			await fetchStackFiles(module);
			return ``;
		}
	}
};

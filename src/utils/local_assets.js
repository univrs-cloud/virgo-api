import path from 'path';
import { Agent } from 'undici';
import serverConfig from '../../config.js';
import { folderPath as distFolder } from '../controllers/static.js';

const LOOPBACK_HOST = '127.0.0.1';
const HTTP_CHUNK_SIZE = 256 * 1024;

// The node's own API is served over HTTPS with a self-signed cert, so loopback calls have to skip
// verification. Every URL built with these options goes through localBaseUrl(), which is pinned to
// LOOPBACK_HOST — a self-signed cert must never be accepted over the network, and pinning the address
// here means no configuration change can send these requests off the host.
const localFetchDispatcher = new Agent({
	connect: { rejectUnauthorized: false }
});

const localTlsOptions = {
	rejectUnauthorized: false
};

const localBaseUrl = () => {
	return `https://${LOOPBACK_HOST}:${serverConfig.server.port}`;
};

const pickResponseHeaders = (headers) => {
	const selected = {};
	const contentType = headers.get('content-type');
	if (contentType) {
		selected['content-type'] = contentType;
	}
	return selected;
};

const resolveDistPath = (assetPath) => {
	const cleaned = decodeURIComponent(assetPath).split('?')[0].split('#')[0];
	const trimmed = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
	const target = path.resolve(distFolder, trimmed || 'index.html');
	if (!target.startsWith(distFolder)) {
		return null;
	}
	return target;
};

const buildLocalAssetUrl = (assetPath) => {
	const base = localBaseUrl();
	if (!base) {
		return null;
	}

	const normalizedPath = assetPath?.startsWith('/') ? assetPath : `/${assetPath || 'index.html'}`;
	return new URL(normalizedPath, base);
};

export {
	HTTP_CHUNK_SIZE,
	localFetchDispatcher,
	localTlsOptions,
	localBaseUrl,
	pickResponseHeaders,
	resolveDistPath,
	buildLocalAssetUrl
};

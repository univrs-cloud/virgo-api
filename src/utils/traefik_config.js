const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const TRAEFIK_CONFIG_PATH = '/messier/apps/traefik/config';
const TRAEFIK_ENV_PATH = '/opt/docker/traefik/.env';
const IGNORED_FILES = ['traefik.yml', 'local-service.yml'];

/**
 * Reads the DOMAIN value from the Traefik .env file
 * @returns {string|null}
 */
const getDomain = () => {
	try {
		if (!fs.existsSync(TRAEFIK_ENV_PATH)) {
			console.error(`Traefik .env file not found: ${TRAEFIK_ENV_PATH}`);
			return null;
		}
		const content = fs.readFileSync(TRAEFIK_ENV_PATH, 'utf8');
		const match = content.match(/^DOMAIN=["']?([^"'\n]+)["']?$/m);
		if (!match) {
			console.error('DOMAIN not found in Traefik .env file');
			return null;
		}
		return match[1].trim();
	} catch (error) {
		console.error('Error reading Traefik .env file:', error.message);
		return null;
	}
};

/**
 * Reads all Traefik YAML config files from the config directory
 * @returns {Promise<Array<{name: string, config: object}>>}
 */
const readAll = async () => {
	const configs = [];
	
	try {
		if (!fs.existsSync(TRAEFIK_CONFIG_PATH)) {
			return configs;
		}
		
		const files = fs.readdirSync(TRAEFIK_CONFIG_PATH);
		
		for (const file of files) {
			if (!file.endsWith('.yml') || IGNORED_FILES.includes(file)) {
				continue;
			}
			
			const filePath = path.join(TRAEFIK_CONFIG_PATH, file);
			const content = fs.readFileSync(filePath, 'utf8');
			
			try {
				const parsed = parse(content);
				if (parsed) {
					configs.push({
						name: file.replace('.yml', ''),
						configFile: file,
						...parsed
					});
				}
			} catch (error) {
				console.error(`Error parsing Traefik config ${file}:`, error.message);
			}
		}
	} catch (error) {
		console.error('Error reading Traefik configs:', error.message);
	}
	
	return configs;
};

/**
 * Pre-processes YAML content to remove Go template syntax before parsing
 * @param {string} content - Raw YAML content with Go templates
 * @returns {string} - YAML content safe for parsing
 */
const preprocessYaml = (content) => {
	// Remove Go template if/else/end blocks for tls field
	// Replace the entire tls template block with a simple placeholder
	return content
		.replace(/tls:\s*\{\{\s*if[^}]*\}\}[\s\S]*?\{\{\s*end\s*\}\}/g, 'tls: {}')
		.replace(/\{\{\s*env\s*`[^`]*`\s*\}\}/g, 'TEMPLATE_VAR');
};

/**
 * Parses a Traefik YAML config and extracts relevant fields
 * @param {string} yamlContent - Raw YAML content
 * @returns {object|null} - Parsed config with subdomain, backendUrl, isAuthRequired
 */
const parse = (yamlContent) => {
	const preprocessed = preprocessYaml(yamlContent);
	const doc = yaml.load(preprocessed);
	
	if (!doc?.http?.routers || !doc?.http?.services) {
		return null;
	}
	
	const routerNames = Object.keys(doc.http.routers);
	if (routerNames.length === 0) {
		return null;
	}
	
	const routerName = routerNames[0];
	const router = doc.http.routers[routerName];
	const service = doc.http.services[routerName];
	
	if (!router?.rule || !service?.loadBalancer?.servers?.[0]?.url) {
		return null;
	}
	
	// Extract subdomain from router rule: Host(`subdomain.TEMPLATE_VAR`)
	const ruleMatch = router.rule.match(/Host\(`([^.`]+)\./);
	const subdomain = ruleMatch ? ruleMatch[1] : null;
	
	// Extract backend URL from service
	const backendUrl = service.loadBalancer.servers[0].url;
	
	// Check if authelia middleware is present
	const middlewares = router.middlewares || [];
	const isAuthRequired = middlewares.includes('authelia@file');
	
	return {
		subdomain,
		backendUrl,
		isAuthRequired
	};
};

/**
 * Matches a Traefik config to a bookmark by comparing protocol, subdomain, and domain
 * @param {object} config - Parsed Traefik config
 * @param {object} bookmark - Bookmark object with url field
 * @returns {boolean}
 */
const match = (config, bookmark) => {
	const domain = getDomain();
	if (!config?.subdomain || !bookmark?.url || !domain) {
		return false;
	}
	
	try {
		const url = new URL(bookmark.url);
		
		// Check protocol is https
		if (url.protocol !== 'https:') {
			return false;
		}
		
		// Check hostname matches subdomain.domain
		const expectedHostname = `${config.subdomain}.${domain}`;
		const matches = url.hostname === expectedHostname;
		return matches;
	} catch {
		return false;
	}
};

/**
 * Generates a Traefik YAML config from options
 * @param {string} name - Router/service name
 * @param {object} options - Config options
 * @param {string} options.subdomain - Subdomain for router rule
 * @param {string} options.backendUrl - Backend service URL
 * @param {boolean} options.isAuthRequired - Include authelia middleware
 * @returns {string} - YAML config string
 */
const generate = (name, options) => {
	const { subdomain, backendUrl, isAuthRequired } = options;
	
	const middlewares = isAuthRequired
		? `
        - "secure-headers@file"
        - "authelia@file"`
		: `
        - "secure-headers@file"`;
	
	// Use template string to preserve Go template syntax exactly
	return `http:
  routers:
    ${name}:
      rule: "Host(\`${subdomain}.{{ env \`DOMAIN\` }}\`)"
      entryPoints:
        - "https"
      service: "${name}"
      tls: {{ if ne (env \`CERTRESOLVER\`) "" }}
        certResolver: "{{ env \`CERTRESOLVER\` }}"
      {{ else }}
        {}
      {{ end }}
      middlewares:${middlewares}

  services:
    ${name}:
      loadBalancer:
        servers:
          - url: "${backendUrl}"
        serversTransport: "insecure-transport@file"
`;
};

/**
 * Writes a Traefik config file
 * @param {string} name - Config name (becomes {name}.yml)
 * @param {object} options - Config options
 * @returns {Promise<boolean>}
 */
const write = async (name, options) => {
	try {
		const yamlContent = generate(name, options);
		const filePath = path.join(TRAEFIK_CONFIG_PATH, `${name}.yml`);
		
		// Ensure directory exists
		if (!fs.existsSync(TRAEFIK_CONFIG_PATH)) {
			fs.mkdirSync(TRAEFIK_CONFIG_PATH, { recursive: true });
		}
		
		fs.writeFileSync(filePath, yamlContent, 'utf8');
		return true;
	} catch (error) {
		console.error(`Error writing Traefik config ${name}:`, error.message);
		return false;
	}
};

/**
 * Deletes a Traefik config file
 * @param {string} name - Config name (deletes {name}.yml)
 * @returns {Promise<boolean>}
 */
const remove = async (name) => {
	try {
		const filePath = path.join(TRAEFIK_CONFIG_PATH, `${name}.yml`);
		
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
			return true;
		}
		return false;
	} catch (error) {
		console.error(`Error deleting Traefik config ${name}:`, error.message);
		return false;
	}
};

/**
 * Enriches bookmarks with Traefik config data
 * @param {Array} bookmarks - Array of bookmark objects
 * @returns {Promise<Array>} - Bookmarks with traefik field added
 */
const enrichBookmarks = async (bookmarks) => {
	const configs = await readAll();
	
	return bookmarks.map((bookmark) => {
		const matchedConfig = configs.find((config) => match(config, bookmark));
		
		return {
			...bookmark,
			traefik: matchedConfig ? {
				subdomain: matchedConfig.subdomain,
				backendUrl: matchedConfig.backendUrl,
				isAuthRequired: matchedConfig.isAuthRequired,
				configFile: matchedConfig.configFile
			} : null
		};
	});
};

module.exports = {
	getDomain,
	readAll,
	parse,
	match,
	generate,
	write,
	remove,
	enrichBookmarks,
	TRAEFIK_CONFIG_PATH,
	TRAEFIK_ENV_PATH
};

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// Run in a fresh process, so the answer does not depend on what other tests already imported.
function modulesLoadedBy(specifiers) {
	const script = `
		${specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n')}
		const { createRequire } = await import('node:module');
		const loaded = Object.keys(createRequire(import.meta.url).cache);
		console.log(JSON.stringify(loaded));
	`;
	return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
}

test('importing the indexer does not load the node\'s own database', () => {
	const loaded = modulesLoadedBy(['./indexer/index.js', './indexer/flush.js', './indexer/query.js', './indexer/zfs.js']);
	const offenders = loaded.filter((file) => /node_modules\/(sequelize|sqlite3)\//.test(file));
	assert.deepEqual(offenders, [], 'The indexer modules must be importable without opening /messier/.config/virgo.db');
});

test('the test fixture does not load the node\'s own database', () => {
	const loaded = modulesLoadedBy(['./test/helpers/indexer-fixture.js']);
	assert.deepEqual(loaded.filter((file) => /node_modules\/(sequelize|sqlite3)\//.test(file)), []);
});

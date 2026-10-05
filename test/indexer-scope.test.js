import assert from 'node:assert/strict';
import test from 'node:test';
import { isInScope, isTrash } from '../indexer/scope.js';
import { parseDiffLine, scopeDiffEntry } from '../indexer/zfs.js';

const MOUNT = '/messier/apps/nextcloud';

test('only users\' files, their trash and group folders are indexed', () => {
	const cases = [
		['/data', true, true],
		['/data/olivia', true, true],
		['/data/olivia/files', true, true],
		['/data/olivia/files/Documents/report.pdf', false, true],
		['/data/olivia/files_trashbin/files/report.pdf.d1776185835', false, true],
		['/data/__groupfolders/1/files/shared.pdf', false, true],
		['/data/olivia/cache/thumb', false, false],
		['/data/olivia/uploads/chunk', false, false],
		['/data/olivia/files_versions/report.pdf.v1', false, false],
		['/data/appdata_abc/preview/1.jpg', false, false],
		['/data/files_external/rootcerts.crt', false, false],
		['/data/nextcloud.log', false, false],
		['/config/config.php', false, false],
	];
	for (const [path, isDir, expected] of cases) {
		assert.equal(isInScope(path, isDir), expected, path);
	}
});

test('a path is in the trash only inside a user\'s own trash folder', () => {
	assert.equal(isTrash('/data/olivia/files_trashbin/files/report.pdf.d1776185835'), true);
	assert.equal(isTrash('/data/olivia/files/files_trashbin/report.pdf'), false);
	assert.equal(isTrash('/data/__groupfolders/files_trashbin/x'), false);
	assert.equal(isTrash('/data/olivia/files/report.pdf'), false);
});

test('a rename across the edge of the indexed scope becomes an addition or a removal', () => {
	const rename = (fileType, from, to) => {
		const entry = scopeDiffEntry({ changeType: 'renamed', fileType, path: MOUNT + from, newPath: MOUNT + to, changedAt: 1 }, MOUNT);
		return entry && { changeType: entry.changeType, path: entry.path.slice(MOUNT.length), newPath: entry.newPath?.slice(MOUNT.length) ?? null, isSubtree: entry.isSubtree ?? false };
	};
	assert.deepEqual(rename('dir', '/data/olivia/cache/In', '/data/olivia/files/In'), { changeType: 'added', path: '/data/olivia/files/In', newPath: null, isSubtree: true });
	assert.deepEqual(rename('file', '/data/olivia/uploads/f.part', '/data/olivia/files/f.txt'), { changeType: 'added', path: '/data/olivia/files/f.txt', newPath: null, isSubtree: false });
	assert.deepEqual(rename('dir', '/data/olivia/files/Out', '/data/olivia/cache/Out'), { changeType: 'removed', path: '/data/olivia/files/Out', newPath: null, isSubtree: true });
	assert.deepEqual(rename('file', '/data/olivia/files/f.txt', '/data/olivia/cache/f.txt'), { changeType: 'removed', path: '/data/olivia/files/f.txt', newPath: null, isSubtree: false });
	assert.deepEqual(rename('dir', '/data/olivia/files/A', '/data/olivia/files/B'), { changeType: 'renamed', path: '/data/olivia/files/A', newPath: '/data/olivia/files/B', isSubtree: false });
	assert.deepEqual(rename('file', '/data/olivia/files/f', '/data/olivia/files_trashbin/files/f.d1'), { changeType: 'renamed', path: '/data/olivia/files/f', newPath: '/data/olivia/files_trashbin/files/f.d1', isSubtree: false });
	assert.equal(rename('dir', '/data/olivia/cache/a', '/data/olivia/cache/b'), null);
});

test('an event that is not a rename is kept only when its path is indexed', () => {
	const event = (changeType, path) => scopeDiffEntry({ changeType, fileType: 'file', path: MOUNT + path, newPath: null, changedAt: 1 }, MOUNT);
	assert.equal(event('modified', '/data/olivia/files/report.pdf')?.changeType, 'modified');
	assert.equal(event('added', '/data/olivia/cache/thumb'), null);
	assert.equal(event('removed', '/data/appdata_abc/preview/1.jpg'), null);
});

// The lines below are what `zfs diff -FHt` prints, as produced by print_file, print_rename and
// print_link_change in OpenZFS lib/libzfs/libzfs_diff.c (the same in 2.3.4 and 2.4.4).
test('zfs diff lines are read as the events they describe', () => {
	const line = (...fields) => parseDiffLine(fields.join('\t'));
	assert.deepEqual(line('1754000000.123456789', '+', 'F', '/pool/data/a'), { changeType: 'added', fileType: 'file', path: '/pool/data/a', newPath: null, changedAt: 1754000000 });
	assert.deepEqual(line('1754000001.000000000', '-', '/', '/pool/data/dir'), { changeType: 'removed', fileType: 'dir', path: '/pool/data/dir', newPath: null, changedAt: 1754000001 });
	assert.deepEqual(line('1754000002.000000000', 'M', 'F', '/pool/data/a'), { changeType: 'modified', fileType: 'file', path: '/pool/data/a', newPath: null, changedAt: 1754000002 });
	assert.deepEqual(line('1754000003.000000000', 'R', '/', '/pool/data/Old', '/pool/data/New'), { changeType: 'renamed', fileType: 'dir', path: '/pool/data/Old', newPath: '/pool/data/New', changedAt: 1754000003 });
	assert.equal(line('1754000004.000000000', 'M', '@', '/pool/data/link').fileType, 'link');
	assert.equal(line('1754000004.000000000', '+', '|', '/pool/data/fifo').fileType, 'pipe');
	assert.equal(parseDiffLine(''), null);
});

test('a hard-link count change is a modification without a second path', () => {
	const entry = parseDiffLine(['1754000005.000000000', 'M', 'F', '/pool/data/a', '(+1)'].join('\t'));
	assert.deepEqual([entry.changeType, entry.path, entry.newPath], ['modified', '/pool/data/a', null]);
});

test('names are restored from the octal escapes zfs diff writes for spaces and non-ASCII bytes', () => {
	const entry = parseDiffLine(['1754000006.000000000', 'R', 'F', '/pool/data/My\\0040file.txt', '/pool/data/\\0310\\0230tefan\\0040notes.txt'].join('\t'));
	assert.equal(entry.path, '/pool/data/My file.txt');
	assert.equal(entry.newPath, '/pool/data/Ștefan notes.txt');
	assert.equal(parseDiffLine(['1754000007.000000000', '+', 'F', '/pool/data/back\\0134slash'].join('\t')).path, '/pool/data/back\\slash');
});

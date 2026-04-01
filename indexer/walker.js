'use strict';

const { opendir } = require('fs/promises');
const { statSync } = require('fs');

const BATCH_SIZE = 4096;

/**
 * Depth-first crawl of a snapshot mount. Runs entirely on the main thread so we
 * avoid worker ↔ main IPC and lock-free ring races that were wedging crawls on Pi.
 */
async function walkSnapshot(snapshotPath, onBatch) {
  const dirs = [snapshotPath];
  const batch = [];
  let total = 0;

  async function flush() {
    if (!batch.length) return;
    const chunk = batch.splice(0, batch.length);
    total += chunk.length;
    onBatch(chunk);
    await new Promise(r => setImmediate(r));
  }

  while (dirs.length) {
    const dir = dirs.pop();
    try {
      const d = await opendir(dir, { bufferSize: 512 });
      const childDirs = [];
      for await (const entry of d) {
        const fullPath = `${dir === '/' ? '' : dir}/${entry.name}`;
        const relPath = fullPath.startsWith(snapshotPath)
          ? fullPath.slice(snapshotPath.length) || '/'
          : fullPath;

        let inode = 0, size = 0, mtime = 0, ctime = 0, nlink = 1, mode = '0000';
        try {
          const st = statSync(fullPath);
          inode = st.ino;
          size = entry.isDirectory() ? 0 : st.size;
          mtime = Math.floor(st.mtimeMs / 1000);
          ctime = Math.floor(st.ctimeMs / 1000);
          nlink = st.nlink;
          mode = (st.mode & 0o7777).toString(8).padStart(4, '0');
        } catch {}

        const type = entry.isDirectory() ? 'dir'
                   : entry.isSymbolicLink() ? 'link'
                   : entry.isFile() ? 'file'
                   : 'other';

        batch.push({ path: relPath, type, inode, size, mtime, ctime, nlink, mode });

        if (entry.isDirectory() && entry.name !== '.zfs') {
          childDirs.push(fullPath);
        }

        if (batch.length >= BATCH_SIZE) await flush();
      }
      for (let i = childDirs.length - 1; i >= 0; i--) {
        dirs.push(childDirs[i]);
      }
    } catch {
      // Permission denied, gone, etc.
    }
  }

  await flush();
  return total;
}

module.exports = { walkSnapshot };

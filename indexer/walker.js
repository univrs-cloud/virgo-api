'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { opendir }  = require('fs/promises');
const { statSync } = require('fs');
const { cpus }     = require('os');

const NUM_WORKERS  = cpus().length;

const QUEUE_SLOTS  = 32768;
const SLOT_BYTES   = 1024;
const CTRL_INTS    = 4;

// ─── Main thread ─────────────────────────────────────────────────────────────

async function walkSnapshot(snapshotPath, onBatch) {
  if (!isMainThread) throw new Error('walkSnapshot must be called from main thread');

  const sharedBuf = new SharedArrayBuffer(
    CTRL_INTS * 4 + QUEUE_SLOTS * SLOT_BYTES
  );
  const ctrl  = new Int32Array(sharedBuf, 0, CTRL_INTS);
  const queue = new Uint8Array(sharedBuf, CTRL_INTS * 4);

  enqueuePath(ctrl, queue, snapshotPath);

  let doneCount  = 0;
  let totalFiles = 0;

  await new Promise((resolve, reject) => {
    const workers = Array.from({ length: NUM_WORKERS }, () => {
      const w = new Worker(__filename, {
        workerData: { sharedBuf, snapshotPath }
      });
      w.on('message', (batch) => {
        if (batch === null) return;
        totalFiles += batch.length;
        onBatch(batch);
      });
      w.on('error', reject);
      w.on('exit', () => {
        if (++doneCount === NUM_WORKERS) resolve();
      });
      return w;
    });

    const poller = setInterval(() => {
      const head   = Atomics.load(ctrl, 0);
      const tail   = Atomics.load(ctrl, 1);
      const active = Atomics.load(ctrl, 2);
      if (head === tail && active === 0) {
        Atomics.store(ctrl, 3, 1);
        Atomics.notify(ctrl, 0, NUM_WORKERS);
        clearInterval(poller);
      }
    }, 10);
  });

  return totalFiles;
}

function enqueuePath(ctrl, queue, path) {
  const encoded = Buffer.from(path, 'utf8');
  if (encoded.length > SLOT_BYTES - 2) return;

  while (true) {
    const tail     = Atomics.load(ctrl, 1);
    const nextTail = (tail + 1) & (QUEUE_SLOTS - 1);
    const head     = Atomics.load(ctrl, 0);
    if (nextTail === head) continue;
    if (Atomics.compareExchange(ctrl, 1, tail, nextTail) === tail) {
      const offset = tail * SLOT_BYTES;
      const lenBuf = Buffer.from(queue.buffer, CTRL_INTS * 4 + offset, 2);
      lenBuf.writeUInt16LE(encoded.length, 0);
      encoded.copy(Buffer.from(queue.buffer, CTRL_INTS * 4 + offset + 2));
      Atomics.notify(ctrl, 0, 1);
      return;
    }
  }
}

// ─── Worker thread ────────────────────────────────────────────────────────────

if (!isMainThread) {
  const { sharedBuf, snapshotPath } = workerData;
  const ctrl  = new Int32Array(sharedBuf, 0, CTRL_INTS);
  const queue = new Uint8Array(sharedBuf, CTRL_INTS * 4);

  const BATCH_SIZE  = 4096;
  const batch       = [];

  function dequeue() {
    while (true) {
      const head = Atomics.load(ctrl, 0);
      const tail = Atomics.load(ctrl, 1);
      if (head === tail) return null;
      const nextHead = (head + 1) & (QUEUE_SLOTS - 1);
      if (Atomics.compareExchange(ctrl, 0, head, nextHead) === head) {
        const offset = head * SLOT_BYTES;
        const lenBuf = Buffer.from(queue.buffer, CTRL_INTS * 4 + offset, 2);
        const len    = lenBuf.readUInt16LE(0);
        return Buffer.from(queue.buffer, CTRL_INTS * 4 + offset + 2, len).toString('utf8');
      }
    }
  }

  function localEnqueue(path) {
    const encoded = Buffer.from(path, 'utf8');
    if (encoded.length > SLOT_BYTES - 2) return;
    while (true) {
      const tail     = Atomics.load(ctrl, 1);
      const nextTail = (tail + 1) & (QUEUE_SLOTS - 1);
      const head     = Atomics.load(ctrl, 0);
      if (nextTail === head) continue;
      if (Atomics.compareExchange(ctrl, 1, tail, nextTail) === tail) {
        const offset = tail * SLOT_BYTES;
        const lenBuf = Buffer.from(queue.buffer, CTRL_INTS * 4 + offset, 2);
        lenBuf.writeUInt16LE(encoded.length, 0);
        encoded.copy(Buffer.from(queue.buffer, CTRL_INTS * 4 + offset + 2));
        Atomics.notify(ctrl, 0, 1);
        return;
      }
    }
  }

  function flush() {
    if (batch.length) {
      parentPort.postMessage([...batch]);
      batch.length = 0;
    }
  }

  async function run() {
    let isActive = false;

    while (true) {
      const dir = dequeue();

      if (dir === null) {
        if (isActive) {
          Atomics.sub(ctrl, 2, 1);
          isActive = false;
        }
        if (Atomics.load(ctrl, 3) === 1) break;
        Atomics.wait(ctrl, 0, Atomics.load(ctrl, 0), 5);
        continue;
      }

      if (!isActive) {
        Atomics.add(ctrl, 2, 1);
        isActive = true;
      }

      try {
        const d = await opendir(dir, { bufferSize: 128 });
        for await (const entry of d) {
          const fullPath = `${dir === '/' ? '' : dir}/${entry.name}`;
          const relPath  = fullPath.startsWith(snapshotPath)
            ? fullPath.slice(snapshotPath.length) || '/'
            : fullPath;

          let inode = 0, size = 0, mtime = 0, ctime = 0, nlink = 1, mode = '0000';
          try {
            const st = statSync(fullPath);
            inode = st.ino;
            size  = entry.isDirectory() ? 0 : st.size;
            mtime = Math.floor(st.mtimeMs / 1000);
            ctime = Math.floor(st.ctimeMs / 1000);
            nlink = st.nlink;
            mode  = (st.mode & 0o7777).toString(8).padStart(4, '0');
          } catch {}

          const type = entry.isDirectory() ? 'dir'
                     : entry.isSymbolicLink() ? 'link'
                     : entry.isFile() ? 'file'
                     : 'other';

          batch.push({ path: relPath, type, inode, size, mtime, ctime, nlink, mode });

          if (entry.isDirectory() && entry.name !== '.zfs') {
            localEnqueue(fullPath);
          }

          if (batch.length >= BATCH_SIZE) flush();
        }
      } catch {
        // Permission denied, gone, etc — skip silently
      }
    }

    if (isActive) {
      Atomics.sub(ctrl, 2, 1);
    }
    flush();
    parentPort.postMessage(null);
  }

  run().catch(e => { console.error('Worker error:', e); process.exit(1); });
}

module.exports = { walkSnapshot };

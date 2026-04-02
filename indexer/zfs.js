'use strict';

const { execaSync, execa } = require('execa');

function zfsJson(subcmd, ...args) {
  const { stdout } = execaSync('zfs', [subcmd, '-j', '--json-int', ...args]);
  return JSON.parse(stdout);
}

function prop(properties, key) {
  return properties?.[key]?.value ?? null;
}

function discoverAll({ pool = null, dataset = null } = {}) {
  const json = zfsJson(
    'list',
    '-t', 'filesystem,snapshot',
    '-o', 'name,type,creation,used,referenced,mountpoint',
    '-r',
    ...(dataset ? [dataset] : pool ? [pool] : [])
  );

  const datasets  = [];
  const snapshots = [];

  for (const [fullName, entry] of Object.entries(json.datasets ?? {})) {
    const p = entry.properties;

    if (entry.type === 'FILESYSTEM') {
      if (!fullName.includes('/')) continue;

      const mountpoint = prop(p, 'mountpoint');
      datasets.push({
        name:       fullName,
        pool:       entry.pool,
        mountpoint: mountpoint === 'none' ? null : mountpoint,
        created_at: prop(p, 'creation'),
      });

    } else if (entry.type === 'SNAPSHOT') {
      const atIdx       = fullName.indexOf('@');
      const datasetName = fullName.slice(0, atIdx);

      if (!datasetName.includes('/')) continue;

      const snapName = fullName.slice(atIdx + 1);

      snapshots.push({
        dataset_name:     datasetName,
        name:             snapName,
        full_name:        fullName,
        created_at:       prop(p, 'creation'),
        used_bytes:       prop(p, 'used'),
        referenced_bytes: prop(p, 'referenced'),
      });
    }
  }

  snapshots.sort((a, b) => a.created_at - b.created_at);

  return { datasets, snapshots };
}

/**
 * Unescape octal sequences produced by `zfs diff -FHt`.
 * e.g. \040 → space, \011 → tab
 */
function unescapeZfsPath(str) {
  if (!str || !str.includes('\\')) return str;
  return str.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

async function* diffSnapshots(snapA, snapB) {
  const sub = execa('zfs', ['diff', '-FHt', snapA, snapB], {
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let remainder = '';

  try {
    for await (const chunk of sub.stdout) {
      const text = remainder + chunk.toString('utf8');
      const lines = text.split('\n');
      remainder = lines.pop();

      for (const line of lines) {
        const entry = parseDiffLine(line);
        if (entry) yield entry;
      }
    }
  } catch (err) {
    try {
      sub.kill('SIGTERM');
    } catch {}
    const r = await sub.catch(() => ({}));
    const stderr = String(r.stderr ?? '').trim();
    const e = new Error(stderr || `zfs diff stream error ${snapA} → ${snapB}: ${err.message}`);
    e.code = 'ZFS_DIFF_FAILED';
    e.snapA = snapA;
    e.snapB = snapB;
    throw e;
  }

  const r = await sub;
  const stderr = (r.stderr && r.stderr.toString().trim()) || '';
  if (r.exitCode !== 0) {
    const e = new Error(stderr || `zfs diff exited with code ${r.exitCode}`);
    e.code = 'ZFS_DIFF_FAILED';
    e.exitCode = r.exitCode;
    e.snapA = snapA;
    e.snapB = snapB;
    throw e;
  }

  if (remainder.trim()) {
    const entry = parseDiffLine(remainder);
    if (entry) yield entry;
  }
}

function isZfsDiffFailure(err) {
  return Boolean(err && err.code === 'ZFS_DIFF_FAILED');
}

const CHANGE_MAP = {
  '+': 'added',
  '-': 'removed',
  'M': 'modified',
  'R': 'renamed',
};

const FILETYPE_MAP = {
  'F': 'file',
  '/': 'dir',
  '@': 'link',
  'B': 'block',
  'C': 'char',
  'P': 'pipe',
  '=': 'socket',
};

function parseDiffLine(line) {
  if (!line.trim()) return null;

  const parts = line.split('\t');
  if (parts.length < 4) return null;

  const changedAt  = Math.floor(parseFloat(parts[0]));
  const changeChar = parts[1];
  const typeChar   = parts[2];
  const rawPath    = parts[3];
  const rawNewPath = parts[4] ?? null;

  const changeType = CHANGE_MAP[changeChar];
  if (!changeType) {
    console.warn(`  ⚠  Unknown zfs diff change type '${changeChar}' for path: ${rawPath}`);
  }

  return {
    changeType: changeType ?? 'unknown',
    fileType:   FILETYPE_MAP[typeChar] ?? 'other',
    path:       unescapeZfsPath(rawPath),
    newPath:    rawNewPath ? unescapeZfsPath(rawNewPath) : null,
    changedAt,
  };
}

function snapshotMountPath(datasetMountpoint, snapshotName) {
  if (!datasetMountpoint) return null;
  return `${datasetMountpoint}/.zfs/snapshot/${snapshotName}`;
}

module.exports = { discoverAll, diffSnapshots, snapshotMountPath, isZfsDiffFailure };

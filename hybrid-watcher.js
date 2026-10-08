const fs = require('node:fs');
const path = require('node:path');

// Quiet directories are discovered by scans, not recursive OS watches. Only
// directories with relevant file activity get a temporary, nonrecursive watch.
function createHybridWatcher({ root, scanIntervalMs, idleMs, maxWatches,
  isIgnored, isSupported, shouldNotify, onPath, onError }) {
  let snapshot = new Map();
  const watches = new Map();
  let closed = false;
  let scanTimer;
  let lastScan = null;
  let scanErrors = 0;
  let initial = true;

  function drop(dir) {
    const entry = watches.get(dir);
    if (!entry) return;
    watches.delete(dir);
    entry.watcher.close();
  }
  function prune() {
    const now = Date.now();
    for (const [dir, entry] of watches) if (now - entry.activeAt >= idleMs) drop(dir);
  }
  function activate(dir) {
    if (closed) return;
    if (watches.has(dir)) { watches.get(dir).activeAt = Date.now(); return; }
    prune();
    if (watches.size >= maxWatches) {
      const oldest = [...watches].reduce((a, b) => a[1].activeAt <= b[1].activeAt ? a : b);
      drop(oldest[0]);
    }
    try {
      const watcher = fs.watch(dir, { recursive: false }, (_event, filename) => {
        if (!filename || closed) return;
        const rel = path.relative(root, path.join(dir, filename.toString()));
        if (isIgnored(rel) || !isSupported(rel) || !shouldNotify(rel)) return;
        const notify = () => {
          if (closed) return;
          const entry = watches.get(dir);
          if (entry) entry.activeAt = Date.now();
          onPath(rel);
        };
        fs.promises.lstat(path.join(root, rel)).then(stat => {
          if (stat.isFile()) notify();
        }).catch(error => {
          if (error.code === 'ENOENT') notify();
          else onError(error);
        });
      });
      watches.set(dir, { watcher, activeAt: Date.now() });
      watcher.on('error', error => { drop(dir); onError(error); });
    } catch (error) {
      // A directory can disappear between scanning it and adding its watch.
      if (error.code !== 'ENOENT') onError(error);
    }
  }

  async function scan() {
    const next = new Map();
    const failed = [];
    scanErrors = 0;
    async function visit(dir) {
      if (closed) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (error) { failed.push(dir); scanErrors++; return; }
      for (const entry of entries) {
        if (closed) return;
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs);
        // Do not follow symlinks into additional trees (or cycles).
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!isIgnored(rel, entry)) await visit(abs);
        } else if (entry.isFile() && isSupported(rel) && !isIgnored(rel, entry)) {
          try {
            const stat = await fs.promises.stat(abs);
            next.set(rel, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`);
          } catch (error) {
            if (error.code !== 'ENOENT') { failed.push(abs); scanErrors++; }
          }
        }
      }
    }
    await visit(root);
    if (closed) return;
    // A failed read isn't a deletion. Retain old entries until a later scan
    // can inspect that subtree successfully.
    const failedRelative = failed.map(abs => path.relative(root, abs));
    for (const [rel, value] of snapshot) {
      if (failedRelative.some(prefix => !prefix || rel === prefix || rel.startsWith(prefix + path.sep))) {
        if (!next.has(rel)) next.set(rel, value);
      }
    }
    prune();
    if (!initial) {
      const changed = new Set();
      for (const [rel, value] of next) if (snapshot.get(rel) !== value) changed.add(rel);
      for (const rel of snapshot.keys()) if (!next.has(rel)) changed.add(rel);
      for (const rel of changed) {
        if (!shouldNotify(rel)) continue;
        activate(path.dirname(path.join(root, rel)));
        onPath(rel);
      }
    }
    snapshot = next;
    initial = false;
    lastScan = Date.now();
  }
  async function loop() {
    try { await scan(); }
    catch (error) { scanErrors++; onError(error); }
    if (!closed) scanTimer = setTimeout(loop, scanIntervalMs);
  }
  const idleTimer = setInterval(prune, Math.min(1000, idleMs));
  return {
    async start() {
      await scan();
      if (!closed) scanTimer = setTimeout(loop, scanIntervalMs);
    },
    status() {
      return { mode: 'hybrid', activeDirectories: watches.size, maxWatches,
        trackedFiles: snapshot.size, lastScan, scanErrors, scanIntervalMs, idleMs };
    },
    close() {
      closed = true;
      clearTimeout(scanTimer);
      clearInterval(idleTimer);
      for (const dir of watches.keys()) drop(dir);
    }
  };
}
module.exports = { createHybridWatcher };

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHybridWatcher } = require('../hybrid-watcher');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) assert.fail('condition timed out');
    await sleep(20);
  }
}
function kernelWatches(pid = process.pid) {
  if (process.platform !== 'linux') return null;
  let count = 0;
  for (const fd of fs.readdirSync(`/proc/${pid}/fdinfo`)) {
    try { count += (fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^inotify wd:/gm) || []).length; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return count;
}

it('discovers deep edits, caps watches, expires them, and rediscovers edits after expiry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stack-hybrid-'));
  const events = [];
  const errors = [];
  let watcher;
  try {
    for (let i = 0; i < 30; i++) {
      fs.mkdirSync(path.join(root, `repo-${i}`, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, `repo-${i}`, 'docs', 'design.md'), 'baseline');
    }
    const before = kernelWatches();
    watcher = createHybridWatcher({ root, scanIntervalMs: 100, idleMs: 250, maxWatches: 2,
      isIgnored: () => false, isSupported: rel => rel.endsWith('.md'), shouldNotify: () => true,
      onPath: rel => events.push(rel), onError: error => errors.push(error) });
    await watcher.start();
    assert.equal(watcher.status().trackedFiles, 30);
    assert.equal(watcher.status().activeDirectories, 0);
    assert.deepEqual(events, []); // Existing files aren't shown at startup.
    if (before !== null) assert.equal(kernelWatches(), before);
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `repo-${i}`, 'docs', 'design.md'), 'changed');
    await until(() => ['repo-0/docs/design.md', 'repo-1/docs/design.md', 'repo-2/docs/design.md'].every(rel => events.includes(rel)));
    assert.equal(watcher.status().activeDirectories, 2);
    if (before !== null) assert.equal(kernelWatches() - before, 2);
    await until(() => watcher.status().activeDirectories === 0);
    if (before !== null) assert.equal(kernelWatches(), before);
    events.length = 0;
    const deep = path.join(root, 'repo-0', 'docs', 'design.md');
    fs.writeFileSync(deep, 'edited while cold');
    await until(() => events.includes('repo-0/docs/design.md'));
    assert.ok(watcher.status().activeDirectories > 0);
    events.length = 0;
    fs.unlinkSync(deep);
    await until(() => events.includes('repo-0/docs/design.md'));
    await until(() => watcher.status().trackedFiles === 29);
    events.length = 0;
    fs.writeFileSync(deep, 'recreated');
    await until(() => events.includes('repo-0/docs/design.md'));
    assert.deepEqual(errors, []);
  } finally {
    watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('active directory watches deliver updates between infrequent scans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stack-hybrid-fast-'));
  let watcher;
  const events = [];
  try {
    watcher = createHybridWatcher({ root, scanIntervalMs: 1000, idleMs: 5000, maxWatches: 1,
      isIgnored: () => false, isSupported: rel => rel.endsWith('.md'), shouldNotify: () => true,
      onPath: rel => events.push(rel), onError: error => { throw error; } });
    await watcher.start();
    fs.writeFileSync(path.join(root, 'a.md'), 'first');
    await until(() => watcher.status().activeDirectories === 1);
    events.length = 0;
    const lastScan = watcher.status().lastScan;
    fs.writeFileSync(path.join(root, 'a.md'), 'second');
    await until(() => events.includes('a.md'), 500);
    assert.equal(watcher.status().lastScan, lastScan);
  } finally { watcher?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('never scans excluded trees or follows symlinks, including in active folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stack-hybrid-filter-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stack-hybrid-outside-'));
  const events = [];
  let watcher;
  try {
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.writeFileSync(path.join(root, 'tmp', 'ignored.md'), 'ignored');
    fs.writeFileSync(path.join(outside, 'outside.md'), 'outside');
    fs.symlinkSync(outside, path.join(root, 'linked-dir'));
    watcher = createHybridWatcher({ root, scanIntervalMs: 100, idleMs: 2000, maxWatches: 2,
      isIgnored: rel => rel === 'tmp' || rel.startsWith('tmp/'),
      isSupported: rel => rel.endsWith('.md'), shouldNotify: () => true,
      onPath: rel => events.push(rel), onError: error => { throw error; } });
    await watcher.start();
    assert.equal(watcher.status().trackedFiles, 0);
    fs.writeFileSync(path.join(root, 'a.md'), 'activate');
    await until(() => watcher.status().activeDirectories === 1);
    events.length = 0;
    fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'linked.md'));
    fs.writeFileSync(path.join(root, 'tmp', 'ignored.md'), 'changed');
    await sleep(400);
    assert.ok(!events.includes('linked.md'));
    assert.ok(!events.includes('tmp/ignored.md'));
    assert.equal(watcher.status().trackedFiles, 1);
  } finally {
    watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

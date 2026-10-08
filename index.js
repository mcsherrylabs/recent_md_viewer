#!/usr/bin/env node

const { program, Option } = require('commander');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

program
  .name('md-stack')
  .description('Live-stacking markdown reviewer for Claude Code edits')
  .version(require('./package.json').version)
  .option('-p, --port <number>', 'port to run web interface on', '26622')
  .option('-H, --host <address>', 'address to listen on (0.0.0.0 exposes it to your network)', '127.0.0.1')
  .option('-e, --expiry <minutes>', 'expiry time in minutes for inactive files', '30')
  .option('-d, --dir <path>', 'directory to watch', process.cwd())
  .option('--ignore-dir <pattern>', 'exclude directory names (supports * and ?); repeat to add patterns',
    (value, patterns) => [...patterns, value], [])
  .option('--include-hidden', 'watch hidden directories (standard exclusions still apply)', false)
  .addOption(new Option('-w, --watcher <type>', 'file watcher to use (auto: native on macOS/Windows, chokidar elsewhere)')
    .choices(['auto', 'native', 'chokidar', 'hybrid']).default('auto'))
  .option('--scan-interval <seconds>', 'hybrid: seconds between scans of unwatched files', '5')
  .option('--watch-idle <seconds>', 'hybrid: release directory watches after inactivity', '60')
  .option('--max-watches <number>', 'hybrid: maximum active directory watches', '128')
  .parse(process.argv);

const options = program.opts();
const PORT = parseInt(options.port, 10);
const HOST = options.host;
const EXPIRY_MS = parseFloat(options.expiry) * 60 * 1000;
const WATCH_DIR = path.resolve(options.dir);
const SCAN_INTERVAL_MS = Number(options.scanInterval) * 1000;
const WATCH_IDLE_MS = Number(options.watchIdle) * 1000;
const MAX_WATCHES = Number(options.maxWatches);
if (!Number.isFinite(SCAN_INTERVAL_MS) || SCAN_INTERVAL_MS < 50 ||
    !Number.isFinite(WATCH_IDLE_MS) || WATCH_IDLE_MS < 50 ||
    !Number.isSafeInteger(MAX_WATCHES) || MAX_WATCHES < 1) {
  program.error('scan interval and watch idle must be at least 0.05 seconds; max watches must be a positive integer');
}
let hybridWatcher;

// macOS (FSEvents) and Windows watch a whole tree natively with one handle, so
// size doesn't matter. Linux has no native recursive watch: Node emulates it by
// watching every file with no way to skip node_modules, so chokidar is used there
const USE_NATIVE = options.watcher === 'native' ||
  (options.watcher === 'auto' && ['darwin', 'win32'].includes(process.platform));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let activeStack = new Map();

// File types that can be stacked, ticked on and off from the dashboard. Markdown
// is rendered; any other type is shown as source in a code block
const FILE_TYPES = { md: '.md', scala: '.scala' };
const fileType = filePath => Object.keys(FILE_TYPES).find(type => path.extname(filePath) === FILE_TYPES[type]);

// The ticked types (Markdown only to start with) live here with the stack, so every
// dashboard shares them and a reload keeps them; a restart resets both
const enabledTypes = new Set(['md']);
// When each type was last ticked (types ticked from the start count as always). A
// file that isn't stacked yet only joins if it changed after that, so files touched
// while their box was unticked stay off (see watchedTypes for the other reason)
const tickedAt = { md: 0 };
// Types chokidar watches. A type is added when first ticked and never removed:
// chokidar re-reads a folder whenever something in it changes, so dropping a type
// would make it report that type's files as deleted. Adding one makes it report
// the folder's untouched files of that type as new, which tickedAt filters out
const watchedTypes = new Set(enabledTypes);

function setTypeEnabled(type, on) {
  if (on === enabledTypes.has(type)) return;
  if (on) {
    enabledTypes.add(type);
    watchedTypes.add(type);
    tickedAt[type] = Date.now();
  } else {
    enabledTypes.delete(type);
  }
}

// Periodic cleanup of expired items
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [filePath, data] of activeStack.entries()) {
    if (now - data.timestamp > EXPIRY_MS) {
      activeStack.delete(filePath);
      changed = true;
    }
  }
  if (changed) broadcastStack();
}, 10000);

// Dependency/build/cache folders are skipped entirely: Linux needs one inotify
// watch per directory, and big trees (e.g. ~/develop) can exhaust the limit
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'target', 'venv', '.venv', '__pycache__', 'dist', 'build',
  '.next', '.cache', '.cargo', '.gradle', '.pytest_cache', '.mypy_cache', '.turbo',
  'coverage', 'vendor', 'tmp', 'temp'
]);
// Match directory basenames at any depth. Compile once; no filesystem glob
// expansion or additional tree scan is needed.
const ignoredDirPatterns = options.ignoreDir.map(pattern => {
  if (!pattern || /[/\\]/.test(pattern)) {
    program.error('--ignore-dir expects a directory name pattern without path separators');
  }
  const expression = [...pattern].map(char => char === '*' ? '.*' : char === '?' ? '.' :
    char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`);
});
const isIgnored = (relPath, stats) => {
  if (!relPath) return false; // Always keep the explicitly selected watch root.
  const segments = relPath.split(path.sep);
  // A hidden Markdown filename is allowed; only directory components count.
  if (!stats?.isDirectory()) segments.pop();
  return segments.some(segment => IGNORED_DIRS.has(segment) ||
    (!options.includeHidden && segment.startsWith('.')) ||
    ignoredDirPatterns.some(pattern => pattern.test(segment)));
};

const escapeHtml = str => str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render(filePath, rawContent) {
  const type = fileType(filePath);
  if (type === 'md') return marked.parse(rawContent);
  return `<pre><code class="language-${type}">${escapeHtml(rawContent)}</code></pre>`;
}

function updateFile(filePath) {
  try {
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const htmlContent = render(filePath, rawContent);
    const relativePath = path.relative(WATCH_DIR, filePath);

    activeStack.set(relativePath, {
      path: relativePath,
      absPath: filePath,
      html: htmlContent,
      timestamp: Date.now()
    });
    broadcastStack();
  } catch (err) {
    // Ignore transient read errors while files are being saved
  }
}

// Deleted files become a content-less marker until dismissed or expired;
// re-creating the file replaces the marker via updateFile
function removeFile(filePath) {
  const relativePath = path.relative(WATCH_DIR, filePath);
  activeStack.set(relativePath, { path: relativePath, deleted: true, timestamp: Date.now() });
  broadcastStack();
}

// Once a watch limit is hit, every remaining folder fails the same way, so a big
// tree would print thousands of identical errors. Each error code is reported
// once with a fix, and the rest are counted and summarized
const WATCH_ERROR_HINTS = {
  ENOSPC: 'The inotify watch limit is reached. Raise it with: sudo sysctl fs.inotify.max_user_watches=524288',
  EMFILE: process.platform === 'linux'
    ? 'The inotify instance limit is reached. Raise it with: sudo sysctl fs.inotify.max_user_instances=1024'
    : 'The open file limit is reached (each watched .md file uses one). --watcher native avoids this on macOS and Windows.'
};
WATCH_ERROR_HINTS.ENFILE = WATCH_ERROR_HINTS.EMFILE;

const watchErrors = new Map(); // error code -> number of paths that failed
let unreportedErrors = 0;
let reportTimer = null;
let scanDone = false;

function watchErrorSummary() {
  const total = [...watchErrors.values()].reduce((a, b) => a + b, 0);
  return `${total} path${total === 1 ? '' : 's'} could not be watched (${[...watchErrors.keys()].join(', ')})`;
}

// Shown on the dashboard, since the log isn't visible when md-stack runs as a service
function watchWarning() {
  if (!watchErrors.size) return null;
  const hints = new Set([...watchErrors.keys()].map(code => WATCH_ERROR_HINTS[code]).filter(Boolean));
  return { summary: hybridWatcher
    ? `${watchErrorSummary()}; periodic scans still detect changes.`
    : `${watchErrorSummary()}, so changes in them won't show up.`, hints: [...hints] };
}

function reportWatchErrors() {
  reportTimer = null;
  if (!unreportedErrors) return;
  console.error(` ${unreportedErrors} more watcher error${unreportedErrors === 1 ? '' : 's'}; ${watchErrorSummary()} so far`);
  unreportedErrors = 0;
  broadcastStack();
}

function onWatchError(err) {
  const code = err.code || err.message;
  const count = (watchErrors.get(code) || 0) + 1;
  watchErrors.set(code, count);
  if (count === 1) {
    console.error(` Watcher error: ${err.message}`);
    if (WATCH_ERROR_HINTS[code]) console.error(`   ${WATCH_ERROR_HINTS[code]}`);
    console.error('   Or watch a smaller folder with --dir. Further errors like this are counted, not printed.');
    broadcastStack();
    return;
  }
  // Repeats during the initial scan are summarized on 'ready'; later ones at most once a minute
  unreportedErrors++;
  if (scanDone && !reportTimer) reportTimer = setTimeout(reportWatchErrors, 60000);
}

// Both watchers can fire several times per save, and chokidar drops changes
// within 50ms of the last one, so the final write of a burst could be missed
// (or the file read half-written). Each path waits until it's been quiet for
// SETTLE_MS, longer than chokidar's window, and then we look at what's on disk
const SETTLE_MS = 100;
const pendingPaths = new Map(); // relative path -> settle timer

const stackedUnder = dir => [...activeStack.values()].filter(i => !i.deleted && i.path.startsWith(dir + path.sep));

function schedulePath(relPath) {
  clearTimeout(pendingPaths.get(relPath));
  pendingPaths.set(relPath, setTimeout(() => {
    pendingPaths.delete(relPath);
    settlePath(relPath);
  }, SETTLE_MS));
}

function settlePath(relPath) {
  const absPath = path.join(WATCH_DIR, relPath);
  const statFile = hybridWatcher ? fs.lstat : fs.stat;
  statFile(absPath, (err, stats) => {
    // Stacked files stay current while their type is unticked (and hidden), so
    // they're up to date if it's ticked again
    const stacked = activeStack.has(relPath);
    const type = fileType(relPath);
    if (!err) {
      if (hybridWatcher && stats.isSymbolicLink() && stacked) { removeFile(absPath); return; }
      if (stats.isFile() && (stacked || (enabledTypes.has(type) && stats.mtimeMs >= tickedAt[type]))) updateFile(absPath);
    } else if (err.code === 'ENOENT') {
      if (stacked || enabledTypes.has(type)) removeFile(absPath);
      // The native watcher only reports a deleted or moved folder, not its files
      for (const item of stackedUnder(relPath)) removeFile(item.absPath);
    }
  });
}

// chokidar v4+ has no glob support, so watch the dir and filter.
// Only files added/changed after startup are stacked.
function watchWithChokidar() {
  const watchStart = Date.now();
  const watcher = require('chokidar').watch(WATCH_DIR, {
    ignored: (filePath, stats) =>
      isIgnored(path.relative(WATCH_DIR, filePath), stats) || (stats?.isFile() && !watchedTypes.has(fileType(filePath))),
    persistent: true,
    ignoreInitial: true,
    ignorePermissionErrors: true
  });
  const onPath = filePath => schedulePath(path.relative(WATCH_DIR, filePath));
  watcher
    .on('add', onPath)
    .on('change', onPath)
    .on('unlink', onPath)
    .on('ready', () => {
      scanDone = true;
      const dirs = Object.keys(watcher.getWatched()).length;
      const secs = ((Date.now() - watchStart) / 1000).toFixed(1);
      if (!watchErrors.size) {
        console.log(` Ready: watching ${dirs} dirs (scanned in ${secs}s), waiting for changes...`);
        return;
      }
      console.error(` Ready: scanned ${dirs} dirs in ${secs}s, but ${watchErrorSummary()}.`);
      console.error(`   Changes in those paths won't show up.`);
      unreportedErrors = 0;
      broadcastStack(); // dashboards that connected mid-scan have a stale count
    })
    .on('error', onWatchError);
}

// The native watcher reports a bare 'rename' or 'change' for any path in the
// tree, relative to WATCH_DIR, so the filtering chokidar does happens here
function watchNatively() {
  const onEvent = (eventType, filename) => {
    if (!filename) return;
    const relPath = filename.toString();
    if (isIgnored(relPath)) return;
    // Paths of other types only matter if they are folders holding stacked files
    if (!fileType(relPath) && !stackedUnder(relPath).length) return;
    schedulePath(relPath);
  };
  try {
    fs.watch(WATCH_DIR, { recursive: true, persistent: true }, onEvent).on('error', onWatchError);
  } catch (err) {
    onWatchError(err);
    return;
  }
  scanDone = true;
  console.log(' Ready: watching the whole tree with the native watcher, waiting for changes...');
}

async function watchWithHybrid() {
  hybridWatcher = require('./hybrid-watcher').createHybridWatcher({
    root: WATCH_DIR, scanIntervalMs: SCAN_INTERVAL_MS, idleMs: WATCH_IDLE_MS,
    maxWatches: MAX_WATCHES, isIgnored,
    isSupported: rel => Boolean(fileType(rel)),
    shouldNotify: rel => activeStack.has(rel) || enabledTypes.has(fileType(rel)),
    onPath: schedulePath, onError: onWatchError
  });
  await hybridWatcher.start();
  scanDone = true;
  const status = hybridWatcher.status();
  console.log(` Ready: hybrid scanned ${status.trackedFiles} files; ${status.activeDirectories} active directory watches (limit ${MAX_WATCHES}).`);
}

// Files of unticked types stay on the stack, hidden, until they expire
function serializeStack() {
  const items = Array.from(activeStack.values())
    .filter(item => enabledTypes.has(fileType(item.path)))
    .sort((a, b) => b.timestamp - a.timestamp);
  const types = Object.fromEntries(Object.keys(FILE_TYPES).map(type => [type, enabledTypes.has(type)]));
  return JSON.stringify({ items, types, warning: watchWarning(),
    ...(hybridWatcher ? { watcher: hybridWatcher.status() } : {}) });
}

// Every change sends the whole stack, so a burst (a git checkout, an unzip) sent
// it once per file: quadratic, and enough to run md-stack out of memory. Changes
// within BROADCAST_MS of the last send now go out together in one trailing send
const BROADCAST_MS = 200;
let lastBroadcast = 0;
let broadcastTimer = null;

function broadcastStack() {
  if (broadcastTimer) return;
  const wait = lastBroadcast + BROADCAST_MS - Date.now();
  if (wait > 0) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastStack();
    }, wait);
    return;
  }
  lastBroadcast = Date.now();
  const data = serializeStack();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

wss.on('connection', ws => {
  // Send the current stack to newly connected (or refreshed) browsers
  ws.send(serializeStack());

  // Browsers can dismiss deleted-file markers
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'dismiss' && activeStack.get(msg.path)?.deleted) {
      activeStack.delete(msg.path);
      broadcastStack();
    }
  });
});

// The control panel's actions are plain HTTP so they can be scripted too. Each one
// pushes the new stack to every dashboard and responds with it
const sendStack = res => res.type('json').send(serializeStack());

app.get('/api/stack', (req, res) => sendStack(res));

// Clears hidden files too, so ticking their type again doesn't bring them back
app.post('/api/clear', (req, res) => {
  activeStack.clear();
  broadcastStack();
  sendStack(res);
});

// Takes any subset of { "md": true, "scala": false }
app.post('/api/types', express.json(), (req, res) => {
  const changes = Object.entries(req.body || {});
  if (!changes.length || changes.some(([type, on]) => !Object.hasOwn(FILE_TYPES, type) || typeof on !== 'boolean')) {
    return res.status(400).json({ error: `Expected a JSON object of booleans keyed by ${Object.keys(FILE_TYPES).join(', ')}` });
  }
  for (const [type, on] of changes) setTypeEnabled(type, on);
  broadcastStack();
  sendStack(res);
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>MD Stack - ${path.basename(WATCH_DIR)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; display: flex; height: 100vh; background: #0f1117; color: #e0e6ed; }
    #sidebar { width: 320px; border-right: 1px solid #262936; overflow-y: auto; background: #161822; flex-shrink: 0; }
    .header { height: 48px; box-sizing: border-box; padding: 0 16px; border-bottom: 1px solid #262936; font-weight: bold; font-size: 14px; color: #8b949e; display: flex; align-items: center; justify-content: space-between; }
    .card { padding: 14px 16px; border-bottom: 1px solid #262936; cursor: pointer; transition: background 0.15s ease; }
    .card:hover { background: #1f2230; }
    .card.active { background: #252a3a; border-left: 3px solid #58a6ff; }
    .card-title { font-size: 13px; font-weight: 600; color: #c9d1d9; word-break: break-word; }
    .card-time { font-size: 11px; color: #6e7681; margin-top: 6px; }
    .card.deleted { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; background: #2d1417; border-left: 3px solid #f85149; cursor: default; }
    .card.deleted:hover { background: #3a1a1e; }
    .card.deleted .card-title, .card.deleted .card-time { color: #f85149; }
    .dismiss { background: none; border: none; color: #f85149; font-size: 18px; line-height: 1; padding: 0 2px; cursor: pointer; }
    .dismiss:hover { color: #ffffff; }
    #main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    /* Same height as the sidebar header so their bottom borders line up */
    #controls { height: 48px; box-sizing: border-box; flex-shrink: 0; display: flex; align-items: center; gap: 18px; padding: 0 16px; border-bottom: 1px solid #262936; background: #161822; font-size: 12px; color: #8b949e; }
    #controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    #controls input { margin: 0; accent-color: #58a6ff; color-scheme: dark; cursor: pointer; }
    #clear { background: #252a3a; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 5px 14px; font-size: 12px; cursor: pointer; }
    #clear:hover { background: #2d3344; border-color: #484f58; color: #ffffff; }
    body.disconnected #controls { opacity: 0.5; pointer-events: none; }
    #preview { flex: 1; min-height: 0; padding: 32px 48px; overflow-y: auto; overflow-anchor: none; background: #0f1117; line-height: 1.6; }
    #preview img { max-width: 100%; border-radius: 6px; }
    code { background: #161822; padding: 3px 6px; border-radius: 4px; font-size: 85%; color: #e6edf3; }
    pre { background: #161822; padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid #262936; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #30363d; color: #8b949e; margin: 0; padding-left: 16px; }
    hr { border: 0; height: 1px; background: #262936; margin: 24px 0; }
    a { color: #58a6ff; }
    table { border-collapse: collapse; margin: 16px 0; display: block; max-width: 100%; overflow-x: auto; }
    th, td { border: 1px solid #30363d; padding: 6px 13px; }
    th { background: #161822; font-weight: 600; }
    th:not([align]) { text-align: left; }
    tr:nth-child(even) td { background: #13151d; }
    .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #484f58; font-style: italic; }
    #toast { position: fixed; bottom: 20px; right: 20px; background: #252a3a; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 14px; border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity 0.2s ease; pointer-events: none; }
    #toast.show { opacity: 1; }
    #status { display: none; padding: 8px 16px; font-size: 12px; font-weight: 600; background: #2d1417; color: #f85149; border-bottom: 1px solid #262936; }
    body.disconnected #status { display: block; }
    body.disconnected #card-list { opacity: 0.5; }
    #warning { display: none; padding: 10px 16px; font-size: 12px; line-height: 1.5; background: #2b2111; color: #d29922; border-bottom: 1px solid #262936; }
    #warning code { display: block; margin-top: 4px; overflow-wrap: anywhere; color: #e3b341; }
  </style>
</head>
<body>
  <div id="sidebar">
    <div class="header">
      <span>STACKED FILES</span>
      <span id="count">0</span>
    </div>
    <div id="status">Disconnected from md-stack, reconnecting...</div>
    <div id="warning"></div>
    <div id="card-list"></div>
  </div>
  <div id="main">
    <div id="controls">
      <button id="clear" title="Remove every file from the stack">Clear</button>
      <label title="Stack Markdown files"><input type="checkbox" data-type="md" checked>.md</label>
      <label title="Stack Scala files"><input type="checkbox" data-type="scala">.scala</label>
    </div>
    <div id="preview"><div class="empty">Select a file from the stack to preview...</div></div>
  </div>
  <div id="toast"></div>

  <script>
    let ws;
    let stackData = [];
    let selectedPath = null;

    // Reconnect whenever the socket drops (md-stack restarted, machine slept, SSH
    // tunnel closed); the server sends the whole stack again on connect
    let retryDelay = 1000;
    let retryTimer = null;
    function connect() {
      ws = new WebSocket('ws://' + location.host);
      ws.onopen = () => {
        retryDelay = 1000;
        document.body.classList.remove('disconnected');
      };
      ws.onmessage = onStack;
      ws.onclose = () => {
        document.body.classList.add('disconnected');
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      };
    }

    // Background tabs throttle timers, so retry straight away when the tab is shown again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ws.readyState === WebSocket.CLOSED) {
        clearTimeout(retryTimer);
        connect();
      }
    });

    let enabledTypes = { md: true };

    function onStack(event) {
      const { items, types, warning } = JSON.parse(event.data);
      stackData = items;
      enabledTypes = types;
      document.getElementById('count').innerText = stackData.length;
      document.querySelectorAll('#controls input[data-type]').forEach(box => { box.checked = types[box.dataset.type]; });
      renderWarning(warning);

      // Auto-select latest file if none selected or current was removed/deleted
      const liveFiles = stackData.filter(i => !i.deleted);
      if (!selectedPath || !liveFiles.find(i => i.path === selectedPath)) {
        selectedPath = liveFiles.length > 0 ? liveFiles[0].path : null;
      }

      renderSidebar();
      renderPreview();
    }

    function renderWarning(warning) {
      const el = document.getElementById('warning');
      el.style.display = warning ? 'block' : 'none';
      if (warning) {
        el.innerHTML = escapeHtml(warning.summary) + warning.hints.map(h => '<code>' + escapeHtml(h) + '</code>').join('');
      }
    }

    function escapeHtml(str) {
      return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    function renderSidebar() {
      const container = document.getElementById('card-list');
      container.innerHTML = stackData.map(item => item.deleted ? \`
        <div class="card deleted" data-path="\${escapeHtml(item.path)}">
          <div>
            <div class="card-title">\${escapeHtml(item.path)}</div>
            <div class="card-time">Deleted \${new Date(item.timestamp).toLocaleTimeString()}</div>
          </div>
          <button class="dismiss" title="Dismiss" aria-label="Dismiss">&times;</button>
        </div>
      \` : \`
        <div class="card \${item.path === selectedPath ? 'active' : ''}" data-path="\${escapeHtml(item.path)}" title="Click to preview and copy path">
          <div class="card-title">\${escapeHtml(item.path)}</div>
          <div class="card-time">Updated \${new Date(item.timestamp).toLocaleTimeString()}</div>
        </div>
      \`).join('');
    }

    document.getElementById('card-list').addEventListener('click', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      if (event.target.closest('.dismiss')) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'dismiss', path: card.dataset.path }));
      }
      else if (!card.classList.contains('deleted')) {
        selectFile(card.dataset.path);
        copyPath(card.dataset.path);
      }
    });

    // Clear and the checkboxes change state on the server, which pushes the new
    // stack (and checkbox state) to every open dashboard
    function post(url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then(res => res.ok, () => false)
        .then(ok => { if (!ok) showToast('Could not reach md-stack'); return ok; });
    }

    document.getElementById('clear').addEventListener('click', () => post('/api/clear'));

    document.querySelectorAll('#controls input[data-type]').forEach(box => box.addEventListener('change', () => {
      post('/api/types', { [box.dataset.type]: box.checked }).then(ok => { if (!ok) box.checked = !box.checked; });
    }));

    function selectFile(path) {
      selectedPath = path;
      renderSidebar();
      renderPreview();
    }

    // Copy the file's absolute path for pasting into an editor. navigator.clipboard
    // only exists in secure contexts (https/localhost), so fall back to execCommand
    // when the dashboard is opened over plain http from another host
    function copyPath(relPath) {
      const item = stackData.find(i => i.path === relPath);
      if (!item) return;
      const done = () => showToast('Copied ' + item.absPath);
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = item.absPath;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? done() : showToast('Could not copy path');
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(item.absPath).then(done, fallback);
      else fallback();
    }

    let toastTimer;
    function showToast(text) {
      const toast = document.getElementById('toast');
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
    }

    // Resolve relative image paths against the markdown file's own directory
    function resolveImages(html, mdPath) {
      const dir = mdPath.split('/').slice(0, -1).map(encodeURIComponent).join('/');
      const base = location.origin + '/' + (dir ? dir + '/' : '');
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      tpl.content.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src');
        if (!/^([a-z][a-z0-9+.-]*:|\\/|#)/i.test(src)) img.src = new URL(src, base).href;
      });
      return tpl.innerHTML;
    }

    // Mermaid is a large bundle, so fetch it only once a page contains a diagram
    let mermaidReady;
    function renderMermaid(container) {
      const blocks = container.querySelectorAll('pre > code.language-mermaid');
      if (!blocks.length) return Promise.resolve();
      blocks.forEach(code => {
        const diagram = document.createElement('div');
        diagram.className = 'mermaid';
        diagram.textContent = code.textContent;
        code.parentElement.replaceWith(diagram);
      });
      mermaidReady ||= import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
        .then(mod => {
          mod.default.initialize({ startOnLoad: false, theme: 'dark' });
          return mod.default;
        })
        .catch(err => { mermaidReady = null; throw err; });
      return mermaidReady
        .then(mermaid => mermaid.run({ nodes: container.querySelectorAll('.mermaid') }))
        .catch(() => showToast('Could not render Mermaid diagrams'));
    }

    // Every stack update re-sends all files, so re-rendering an unchanged preview
    // would throw away the reader's scroll position
    let rendered = null;
    function renderPreview() {
      const container = document.getElementById('preview');
      if (!selectedPath) {
        rendered = null;
        const message = Object.values(enabledTypes).some(Boolean) ? 'No files modified yet...' : 'Tick a file type to stack its files...';
        container.innerHTML = '<div class="empty">' + message + '</div>';
        return;
      }
      const item = stackData.find(i => i.path === selectedPath);
      if (item) {
        if (rendered && rendered.path === item.path && rendered.html === item.html) return;
        const scrollTop = rendered && rendered.path === item.path ? container.scrollTop : 0;
        const current = rendered = { path: item.path, html: item.html };
        container.innerHTML = \`<div style="font-size: 12px; color: #58a6ff; margin-bottom: 8px;">\${escapeHtml(item.path)}</div>\` + resolveImages(item.html, item.path);
        container.scrollTop = scrollTop;
        // Until the diagrams land the page is shorter, which clamps the scroll position;
        // put it back without overriding wherever the reader has scrolled since
        renderMermaid(container).then(() => {
          if (rendered === current && container.scrollTop < scrollTop) container.scrollTop = scrollTop;
        });
      }
    }

    connect();
  </script>
</body>
</html>
  `);
});

// Serve images referenced by the markdown files (images only, so the rest of
// the watched directory isn't exposed over HTTP)
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp', '.ico']);
const serveWatchDir = express.static(WATCH_DIR, { dotfiles: 'ignore', index: false });
app.use((req, res, next) => {
  if (IMAGE_EXTS.has(path.extname(req.path).toLowerCase())) return serveWatchDir(req, res, next);
  next();
});

// Clear message instead of a stack trace when the port is taken (ws re-emits
// the server's errors, so it needs the handler too)
function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n Port ${PORT} is already in use - is md-stack already running? Use --port to pick another.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
server.on('error', onListenError);
wss.on('error', onListenError);

// Wildcard addresses aren't browsable, so point at localhost; IPv6 literals need brackets in URLs
const urlHost = ['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;

// Start watching once the port is ours, so a clash doesn't scan a big tree first
server.listen(PORT, HOST, () => {
  console.log(`\n md-stack active!`);
  console.log(` Watching: ${WATCH_DIR}`);
  console.log(` Watcher : ${options.watcher === 'hybrid' ? 'hybrid' : USE_NATIVE ? 'native' : 'chokidar'}`);
  if (options.watcher === 'hybrid') console.log(` Hybrid: scan every ${options.scanInterval}s; release idle watches after ${options.watchIdle}s; limit ${MAX_WATCHES}`);
  console.log(` Ignored directories: ${[...IGNORED_DIRS, ...options.ignoreDir].join(', ')}`);
  console.log(` Hidden directories: ${options.includeHidden ? 'included (standard exclusions still apply)' : 'ignored'}`);
  if (USE_NATIVE && process.platform === 'linux') {
    console.warn(' Native recursive watching on Linux allocates watches before exclusions; use --watcher chokidar to reduce inotify usage.');
  }
  console.log(` Expiry  : ${options.expiry} minutes`);
  console.log(` Listening: ${HOST}`);
  console.log(` Dashboard: http://${urlHost}:${PORT}\n`);
  if (options.watcher === 'hybrid') watchWithHybrid().catch(onWatchError);
  else if (USE_NATIVE) watchNatively();
  else watchWithChokidar();
});

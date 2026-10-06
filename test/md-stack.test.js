// Runs md-stack against a scratch folder, once per watcher, and drives it through
// the same HTTP API the dashboard's control panel uses. Run with `npm test`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    }).on('error', reject);
  });
}

for (const watcher of ['chokidar', 'native']) {
  describe(`md-stack (${watcher} watcher)`, () => {
    let dir, proc, base;

    const write = (name, content = `# ${name}\n`) => fs.writeFileSync(path.join(dir, name), content);
    const stack = () => fetch(base + '/api/stack').then(res => res.json());
    const listed = async () => (await stack()).items.map(i => i.path).sort();
    const post = (url, body) => fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    // File mtimes come from a coarse clock that can lag a few ms behind, so let a
    // tick land before writing files that should count as changed after it
    const setTypes = async types => {
      const res = await post('/api/types', types);
      assert.equal(res.status, 200);
      await sleep(50);
      return res.json();
    };

    // Polls until the stack lists exactly `expected`. A file that should stay off
    // is written before a file that should appear, so once that one shows up the
    // other has had its chance, and listing exactly `expected` proves it didn't
    async function waitForListed(expected) {
      const deadline = Date.now() + 5000;
      let paths;
      while (Date.now() < deadline) {
        paths = await listed();
        if (JSON.stringify(paths) === JSON.stringify([...expected].sort())) {
          await sleep(300); // and it stays that way
          paths = await listed();
          break;
        }
        await sleep(50);
      }
      assert.deepEqual(paths, [...expected].sort());
    }

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stack-test-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      proc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js'),
        '--dir', dir, '--port', String(port), '--watcher', watcher], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      await new Promise((resolve, reject) => {
        proc.stdout.on('data', chunk => { if ((output += chunk).includes('Ready:')) resolve(); });
        proc.stderr.on('data', chunk => { output += chunk; });
        proc.on('exit', code => reject(new Error(`md-stack exited with ${code}:\n${output}`)));
      });
    });

    after(() => {
      proc?.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('serves the control panel', async () => {
      const html = await fetch(base + '/').then(res => res.text());
      assert.match(html, /id="controls"/);
      assert.match(html, /<button id="clear"/);
      assert.match(html, /data-type="md" checked/);
      assert.match(html, /data-type="scala">/);
    });

    it('stacks only .md files by default', async () => {
      assert.deepEqual((await stack()).types, { md: true, scala: false });
      write('old.scala', 'object Old\n');
      write('a.md');
      await waitForListed(['a.md']);
    });

    it('stacks .scala files once ticked, as escaped source', async () => {
      const { types } = await setTypes({ scala: true });
      assert.deepEqual(types, { md: true, scala: true });
      write('B.scala', 'object B { def f = 1 < 2 && "x" != "y" }\n');
      // old.scala was touched while unticked, and seeing B.scala makes chokidar
      // report it as new: it must stay off
      await waitForListed(['B.scala', 'a.md']);
      const items = (await stack()).items;
      const scala = items.find(i => i.path === 'B.scala');
      assert.equal(scala.html, '<pre><code class="language-scala">object B { def f = 1 &lt; 2 &amp;&amp; &quot;x&quot; != &quot;y&quot; }\n</code></pre>');
      assert.match(items.find(i => i.path === 'a.md').html, /<h1>a\.md<\/h1>/);
    });

    it('hides .md files when only .scala is ticked, keeping them current', async () => {
      await setTypes({ md: false });
      write('a.md', '# a.md edited while hidden\n');
      write('c.md');
      write('D.scala', 'object D\n');
      await waitForListed(['B.scala', 'D.scala']);
    });

    it('lists nothing when neither type is ticked', async () => {
      const { items, types } = await setTypes({ scala: false });
      assert.deepEqual(types, { md: false, scala: false });
      assert.deepEqual(items, []);
      write('e.md');
      write('E.scala', 'object E\n');
      await sleep(1500);
      assert.deepEqual(await listed(), []);
    });

    it('shows hidden files again when re-ticked, but not files touched while unticked', async () => {
      await setTypes({ md: true });
      write('f.md');
      await waitForListed(['a.md', 'f.md']);
      const a = (await stack()).items.find(i => i.path === 'a.md');
      assert.match(a.html, /edited while hidden/);
    });

    it('clears every file, and stacks files edited after the clear', async () => {
      await setTypes({ scala: true });
      await waitForListed(['B.scala', 'D.scala', 'a.md', 'f.md']);
      await setTypes({ scala: false });
      const res = await post('/api/clear');
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).items, []);
      assert.deepEqual(await listed(), []);
      // Hidden files were cleared too
      await setTypes({ scala: true });
      assert.deepEqual(await listed(), []);
      write('B.scala', 'object B2\n');
      write('a.md');
      await waitForListed(['B.scala', 'a.md']);
    });

    it('rejects unknown types and non-boolean values', async () => {
      for (const body of [{ rb: true }, { md: 'yes' }, {}, { toString: true }]) {
        assert.equal((await post('/api/types', body)).status, 400, JSON.stringify(body));
      }
      assert.deepEqual((await stack()).types, { md: true, scala: true });
    });

    it('sends a burst of changes in a few messages, not one per file', async () => {
      await post('/api/clear');
      const ws = new WebSocket(base.replace('http', 'ws'));
      const messages = [];
      ws.on('message', data => messages.push(JSON.parse(data)));
      await new Promise(resolve => ws.on('open', resolve));
      fs.mkdirSync(path.join(dir, 'burst'));
      const files = Array.from({ length: 200 }, (_, i) => path.join('burst', `f${i}.md`));
      for (const file of files) write(file);
      await waitForListed(files);
      await sleep(300); // the trailing send
      ws.close();
      assert.ok(messages.length < 30, `${messages.length} messages`);
      assert.equal(messages.at(-1).items.length, files.length);
    });
  });
}

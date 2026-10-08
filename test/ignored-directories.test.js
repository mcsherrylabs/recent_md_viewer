const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function start(dir, flags) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js'),
    '--dir', dir, '--port', String(port), ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Watcher startup timed out: ${output}`)), 10000);
      const ready = chunk => {
        output += chunk;
        if (output.includes('Ready:')) { clearTimeout(timeout); resolve(); }
      };
      proc.stdout.on('data', ready);
      proc.stderr.on('data', ready);
      proc.on('error', error => { clearTimeout(timeout); reject(error); });
      proc.on('exit', code => { clearTimeout(timeout); reject(new Error(`Exited ${code}: ${output}`)); });
    });
  } catch (error) { proc.kill(); throw error; }
  return { proc, output, base: `http://127.0.0.1:${port}` };
}

for (const watcher of ['chokidar', 'native', 'hybrid']) {
  describe(`directory exclusions (${watcher})`, () => {
    for (const includeHidden of [false, true]) {
      it(`${includeHidden ? 'includes' : 'prunes'} hidden directories while preserving standard and custom exclusions`, async () => {
        // Even a hidden root should be watched when explicitly selected.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.md-stack-ignore-'));
        let proc;
        try {
          const excluded = ['tmp', 'temp', 'target', 'node_modules', '.git',
            'visible/tmp', 'visible/container-home-2', 'container-home-general',
            'scratch-a', 'cache.+'];
          for (const folder of [...excluded, '.notes', 'visible/.notes']) {
            fs.mkdirSync(path.join(dir, folder), { recursive: true });
            // Large ignored subtrees must not inflate the watched-dir count.
            for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(dir, folder, `nested-${i}`));
          }
          const flags = ['--watcher', watcher, '--ignore-dir', 'container-home-*',
            '--ignore-dir', 'scratch-?', '--ignore-dir', 'cache.+',
            '--scan-interval', '0.1', '--watch-idle', '0.5', '--max-watches', '2'];
          if (includeHidden) flags.push('--include-hidden');
          const running = await start(dir, flags);
          proc = running.proc;
          assert.match(running.output, /Ignored directories:.*tmp.*temp.*container-home-\*/);
          if (watcher === 'chokidar' && !includeHidden) {
            const watchedDirs = Number(running.output.match(/watching (\d+) dirs/)[1]);
            assert.ok(watchedDirs <= 4, `ignored subtrees consumed watches: ${watchedDirs} dirs`);
            if (process.platform === 'linux') {
              let watches = 0;
              for (const fd of fs.readdirSync(`/proc/${proc.pid}/fdinfo`)) {
                try {
                  watches += (fs.readFileSync(`/proc/${proc.pid}/fdinfo/${fd}`, 'utf8').match(/^inotify wd:/gm) || []).length;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
              }
              assert.ok(watches > 0 && watches <= 5, `unexpected kernel inotify count: ${watches}`);
            }
          }
          for (const folder of [...excluded, '.notes', 'visible/.notes']) {
            fs.writeFileSync(path.join(dir, folder, 'ignored.md'), '# test');
          }
          // New directories after startup must also be excluded.
          fs.mkdirSync(path.join(dir, 'container-home-new'));
          fs.writeFileSync(path.join(dir, 'container-home-new', 'new.md'), '# test');
          // Wildcards must match whole directory names and escape punctuation.
          for (const folder of ['scratch-ab', 'cacheXYZ']) {
            fs.mkdirSync(path.join(dir, folder));
            fs.writeFileSync(path.join(dir, folder, 'allowed.md'), '# test');
          }
          fs.writeFileSync(path.join(dir, 'visible', 'normal.md'), '# test');
          fs.writeFileSync(path.join(dir, '.hidden-file.md'), '# test');
          const expected = ['.hidden-file.md', 'cacheXYZ/allowed.md', 'scratch-ab/allowed.md', 'visible/normal.md'];
          if (includeHidden) expected.push('.notes/ignored.md', 'visible/.notes/ignored.md');
          let actual;
          const deadline = Date.now() + 5000;
          do {
            actual = (await fetch(running.base + '/api/stack').then(r => r.json())).items.map(i => i.path).sort();
            if (JSON.stringify(actual) === JSON.stringify(expected.sort())) break;
            await sleep(100);
          } while (Date.now() < deadline);
          assert.deepEqual(actual, expected.sort());
          await sleep(500);
          actual = (await fetch(running.base + '/api/stack').then(r => r.json())).items.map(i => i.path).sort();
          assert.deepEqual(actual, expected.sort());
        } finally {
          if (proc && proc.exitCode === null) {
            const exited = new Promise(resolve => proc.once('exit', resolve));
            proc.kill(); await exited;
          }
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}

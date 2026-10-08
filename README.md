# recent_md_viewer

`md-stack` watches a folder tree and puts every Markdown file that gets created or
changed onto a live stack in your browser, newest first. It was built to review the
plans, specs and notes that coding agents like Claude Code write, without having to
go looking for which file just changed. It can stack Scala source files too.

- Changed `.md` files show up instantly, rendered, with the most recent at the top
- Tick `.scala` in the control panel to stack Scala files as well, shown as source
- Click a card to preview it and copy its absolute path to the clipboard (handy for
  pasting into your editor)
- Deleted files stay on the stack as red markers until you dismiss them
- Files drop off the stack after a period of inactivity (30 minutes by default), or
  all at once with **Clear**
- Relative image links in the Markdown are resolved and displayed
- ` ```mermaid ` code blocks are rendered as diagrams

Only changes made **after** `md-stack` starts are shown. It doesn't list the
files that were already there.

## Requirements

Node.js 22.12 or newer.

## Install

```bash
npm install -g github:mcsherrylabs/recent_md_viewer
```

This puts an `md-stack` command on your PATH. To remove it:
`npm uninstall -g recent_md_viewer`.

## Usage

```bash
md-stack --dir ~/projects
```

Then open the dashboard URL it prints (<http://127.0.0.1:26622> by default).

The control panel above the preview has:

- **Clear**, which empties the stack. Files that change after that are stacked as usual.
- **`.md` and `.scala` checkboxes**, which pick the file types that are stacked (only
  `.md` to start with). Unticking a type hides its files, and ticking it again brings
  back the ones that haven't expired. Files that change while their type is unticked
  aren't stacked.

The stack and the checkboxes are kept by `md-stack`, so they're the same in every open
dashboard and survive a reload, but a restart resets them. The controls are plain
HTTP, so you can script them too:

```bash
curl http://127.0.0.1:26622/api/stack                  # the stack, as JSON
curl -X POST http://127.0.0.1:26622/api/clear
curl -X POST -H 'Content-Type: application/json' -d '{"scala": true}' \
  http://127.0.0.1:26622/api/types                     # any of "md", "scala"
```

| Option | Default | Description |
| --- | --- | --- |
| `-d, --dir <path>` | current directory | Folder to watch (recursively) |
| `--ignore-dir <pattern>` | none | Additional directory names to exclude at any depth; supports `*` and `?`, and can be repeated. Quote patterns to prevent shell expansion |
| `--include-hidden` | off | Include dot-directories; standard and custom exclusions still apply |
| `-p, --port <number>` | `26622` | Port for the web dashboard |
| `-H, --host <address>` | `127.0.0.1` | Address to listen on |
| `-e, --expiry <minutes>` | `30` | Remove files from the stack after this long without changes |
| `-w, --watcher <type>` | `auto` | `native`, `chokidar`, `hybrid`, or `auto` (native on macOS and Windows, chokidar elsewhere). See "Large trees" |
| `--scan-interval <seconds>` | `5` | Hybrid: delay between completed scans |
| `--watch-idle <seconds>` | `60` | Hybrid: release directory watches after this much inactivity |
| `--max-watches <number>` | `128` | Hybrid: maximum simultaneously watched directories |
| `-V, --version` | | Print the version |
| `-h, --help` | | Show help |

### Viewing it from another machine

By default the dashboard is only reachable from the machine it runs on. If
`md-stack` runs on a remote dev box, the safest option is an SSH tunnel:

```bash
ssh -L 26622:127.0.0.1:26622 my-dev-box
```

and then browse to <http://127.0.0.1:26622> locally.

Alternatively, start it with `--host 0.0.0.0` to listen on all interfaces. There
is no authentication, so anyone who can reach the port can read the rendered
Markdown (and images) under the watched folder.

## Things to know

- **Trusted folders only.** Markdown is rendered as-is, including any raw HTML it
  contains, so a file with a `<script>` tag would run in the dashboard.
- **Mermaid needs the network.** The Mermaid library is fetched from the jsDelivr
  CDN the first time a previewed file contains a diagram. Offline, the diagram
  stays as source and a toast reports the failure.
- **Skipped folders.** Dependency, build and cache folders are never watched:
  `node_modules`, `.git`, `target`, `venv`, `.venv`, `__pycache__`, `dist`,
  `build`, `.next`, `.cache`, `.cargo`, `.gradle`, `.pytest_cache`,
  `.mypy_cache`, `.turbo`, `coverage`, `vendor`, `tmp`, `temp`.
  All directories beginning with `.` are also skipped unless `--include-hidden`
  is set. Hidden Markdown filenames are still watched. The explicitly selected
  `--dir` root is always watched, even if its own name matches an exclusion.
  Add exclusions with repeatable directory basename patterns, for example:
  `md-stack --dir ~/develop --ignore-dir 'container-home-*' --ignore-dir scratch`.
  Patterns match whole directory names at every depth, not relative paths.
  With Chokidar these exclusions prune traversal before watches are allocated;
  with the native watcher they only filter events.
- **Large trees.** On macOS and Windows, `md-stack` uses the operating system's
  native recursive watcher. That's one handle for the whole tree, so size doesn't
  matter. Linux has no native equivalent, so there it uses
  [chokidar](https://github.com/paulmillr/chokidar). chokidar needs one inotify
  watch per directory (skipping the folders listed above) and per `.md` file.
  `.scala` files are only watched once that box has been ticked, and then only
  from when something in their folder changes.
  If a limit is hit, `md-stack` prints the error once, with a suggested fix,
  and then only counts the repeats. The dashboard also shows a warning, because
  anything in folders it couldn't watch won't appear. The usual fixes are:
  ```bash
  sudo sysctl fs.inotify.max_user_watches=524288    # ENOSPC
  sudo sysctl fs.inotify.max_user_instances=1024    # EMFILE: too many open files
  ```
  (add the same settings to `/etc/sysctl.conf` to keep them after a reboot).
  You can also point `--dir` at a smaller folder. On startup `md-stack` prints
  which watcher it's using, and with chokidar how many directories it's watching.
  `--watcher chokidar` switches macOS and Windows back to chokidar if the native
  watcher misbehaves. `--watcher native` on Linux isn't recommended: Node emulates
  it by watching every file in the tree, including `node_modules`.
- **Hybrid watching.** `--watcher hybrid` scans the allowed tree periodically,
  comparing supported files' timestamps, sizes and inode numbers. Existing files
  form an initial baseline and are not stacked until they change. Quiet folders
  use no OS watches. A relevant change activates a nonrecursive watch on that
  file's immediate parent, so subsequent edits arrive promptly. Watches expire
  after inactivity; at the limit, the least recently active directory is evicted.
  Scans continue to detect edits, creations and deletions in unwatched folders.
  This also works for enabled Scala files, and keeps previously stacked files
  current while their type is hidden.

  ```bash
  md-stack --dir ~/develop --watcher hybrid --scan-interval 5 \
    --watch-idle 60 --max-watches 128 --ignore-dir 'container-home-*'
  ```

  Scans do not overlap; the interval starts after each scan finishes. A first edit
  in a quiet folder is delayed until its next scan, which may take longer on large
  trees. Short-lived files created and removed between scans can be missed.
  Scanning trades some CPU/disk activity for fewer inotify watches. Symlinks are
  not followed. Failed subtree reads preserve the previous baseline rather than
  falsely reporting deletion; `watcher` in `/api/stack` reports active watches,
  tracked files, last completed scan and scan errors.
- **Reconnects automatically.** If `md-stack` restarts or the connection drops
  (sleep, SSH tunnel), the open dashboard reconnects without a reload. Until it
  does, it shows a "Disconnected" banner. The stack lives in memory, so a
  restart clears it.

## Run it as a service (Linux, systemd)

The package includes a systemd user service template. To install it:

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|NODE_BIN|$(which node)|" -e "s|MD_STACK_BIN|$(which md-stack)|" \
  "$(npm root -g)/recent_md_viewer/md-stack.service" \
  > ~/.config/systemd/user/md-stack.service
```

Edit `--dir` (and any other options) in `~/.config/systemd/user/md-stack.service`.
The template uses hybrid watching and excludes `container-home-*` directories;
adjust scan/idle intervals, the watch cap, and `--ignore-dir` options in its
`ExecStart` command as needed.
Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now md-stack
journalctl --user -u md-stack -f   # view logs
```

If you use nvm, the Node path is tied to a specific Node version. Re-run the `sed`
step after switching versions or reinstalling.

## Development

```bash
git clone git@github.com:mcsherrylabs/recent_md_viewer.git
cd recent_md_viewer
npm install
node index.js --dir .   # or `npm link` to use the md-stack command from your checkout
npm test                # runs md-stack against a scratch folder with each watcher
```

## License

[ISC](LICENSE)

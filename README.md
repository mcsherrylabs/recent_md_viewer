# recent_md_viewer

`md-stack` watches a folder tree and puts every Markdown file that gets created or
changed onto a live stack in your browser, newest first. It was built to review the
plans, specs and notes that coding agents like Claude Code write, without having to
go looking for which file just changed.

- Changed `.md` files show up instantly, rendered, with the most recent at the top
- Click a card to preview it and copy its absolute path to the clipboard (handy for
  pasting into your editor)
- Deleted files stay on the stack as red markers until you dismiss them
- Files drop off the stack after a period of inactivity (30 minutes by default)
- Relative image links in the Markdown are resolved and displayed

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

| Option | Default | Description |
| --- | --- | --- |
| `-d, --dir <path>` | current directory | Folder to watch (recursively) |
| `-p, --port <number>` | `26622` | Port for the web dashboard |
| `-H, --host <address>` | `127.0.0.1` | Address to listen on |
| `-e, --expiry <minutes>` | `30` | Remove files from the stack after this long without changes |
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
- **Skipped folders.** Dependency, build and cache folders are never watched:
  `node_modules`, `.git`, `target`, `venv`, `.venv`, `__pycache__`, `dist`,
  `build`, `.next`, `.cache`, `.cargo`, `.gradle`, `.pytest_cache`,
  `.mypy_cache`, `.turbo`, `coverage`, `vendor`.
- **Large trees on Linux.** Linux needs one inotify watch per directory. If you
  watch something big and see `ENOSPC` or watcher errors, raise the limit:
  ```bash
  sudo sysctl fs.inotify.max_user_watches=524288
  ```
  (add `fs.inotify.max_user_watches=524288` to `/etc/sysctl.conf` to keep it
  after a reboot). On startup `md-stack` prints how many directories it's watching.

## Run it as a service (Linux, systemd)

The package includes a systemd user service template. To install it:

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|NODE_BIN|$(which node)|" -e "s|MD_STACK_BIN|$(which md-stack)|" \
  "$(npm root -g)/recent_md_viewer/md-stack.service" \
  > ~/.config/systemd/user/md-stack.service
```

Edit `--dir` (and any other options) in `~/.config/systemd/user/md-stack.service`,
then:

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
```

## License

[ISC](LICENSE)

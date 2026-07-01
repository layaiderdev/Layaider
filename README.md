# Layaider

A self-hosted, local-first, AI-assisted development environment for mobile
infrastructure (Termux / Debian-proot on Android). Layaider runs entirely on
the device, with no build step, no Node toolchain, and no mandatory cloud
service. Its only required external dependency is the AI engine you choose; with
a local model it works fully offline.

Layaider gives you, over a phone-friendly web UI on `127.0.0.1`:

- a git tool (status, history, diff, commit, branch, sync) for your projects;
- a files browser confined to the active repository;
- an AI coding session (aider) hosted in a background `tmux` session that keeps
  running when the browser tab is suspended, with a resumable live log;
- host/process monitoring and user-defined service controls.

Stack: Python 3 standard library only (server, routing, git, sessions, storage)
plus a dependency-free vanilla JS/CSS frontend. No frameworks to install.

## Quick start

```sh
cd ~/layaider
python3 main.py          # first run: answer the setup prompts, then it exits
python3 main.py          # starts the server
```

Open `http://127.0.0.1:7070` in your device browser.

Full instructions: [`docs/SETUP.md`](docs/SETUP.md).
Local model endpoints: [`docs/LOCAL_MODELS.md`](docs/LOCAL_MODELS.md).

## Layout

```
layaider/
├── main.py              entry point (config check, first-run init, server)
├── config.example.json  config template (copied to config.json on first run)
├── src/                 core, git, session, storage, servers, api, config
├── public/              frontend assets (index.html, app.js, ui-kit.js, style.css)
├── scripts/             validate.sh (syntax + test runner)
└── tests/               test_security.py (stdlib unittest)
```

`config.json` and `project_hooks.py` are generated on first run (gitignored).

## Tests

```sh
python3 tests/test_security.py
```

stdlib `unittest`, no install required. git-dependent and tmux-dependent tests
skip automatically when those tools are absent.

## Security model

- Binds to `127.0.0.1` only — never `0.0.0.0`.
- All filesystem access is confined to the active repository (or `/public` for
  static assets) by a strict `safe_path` boundary check; path traversal,
  absolute paths, and symlink escapes are rejected.
- All process execution uses `subprocess` argument arrays with `shell=False`.
- API keys are stored in `~/.layaider/aider/keys.list` at mode `0600` and
  are never written to `config.json` or passed on a command line.
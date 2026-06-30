# Layaider setup

Step-by-step setup for a clean Termux or Debian/proot environment on Android.
Run one section, verify it, then move on.

## 1. Prerequisites

Layaider itself needs only Python 3 (3.8+), and `git` and `tmux` on `PATH`.
The AI engine is separate (see section 5).

### Termux

```sh
pkg update
pkg install python git tmux
```

Most users run the AI engine inside a Debian proot (Termux's environment is
awkward for some Python build dependencies). Install one:

```sh
pkg install proot-distro
proot-distro install debian
proot-distro login debian
```

Run the remaining steps **inside** the Debian shell if you go this route.

### Debian / proot

```sh
apt-get update
apt-get install -y python3 git tmux
```

Verify:

```sh
python3 --version
git --version
tmux -V
```

## 2. Get the code

Place Layaider where you want it to live (the install path you will confirm at
first run, e.g. `~/layaider`):

```sh
git clone <your-fork-url> ~/layaider      # or copy the files into ~/layaider
cd ~/layaider
```

## 3. First-time initialization

```sh
python3 main.py
```

On first run Layaider has no `config.json` yet, so it runs the interactive
setup and then exits. You will be asked for three paths (press Enter to accept
the default):

1. **Layaider source installation root** — where these files live
   (default: the current directory).
2. **Debian/proot root filesystem** — the absolute host path of your container
   root (default: `/`).
3. **Managed Git workspace root** — where your projects are cloned/initialized
   (default: `~/layaider-projects`). This is the global fallback; you can pick a
   different repo per session in the UI.

What it does:

- validates each path (read/write test) and creates the workspace directory;
- generates `project_hooks.py` if absent (see section 6);
- if Layaider is nested inside another git repository (including a root
  checkout at `/`), appends an isolation block to that repo's `.gitignore` so it
  never tracks Layaider's tree;
- writes `config.json` and prints a summary.

You can re-run setup later with:

```sh
python3 src/config.py --force
```

## 4. Start the server

```sh
python3 main.py
```

It prints the URL and the active repo. Open it in your device browser:

```
http://127.0.0.1:7070
```

Layaider binds to `127.0.0.1` only. To reach it from another device, put it
behind your own authenticated reverse proxy or an SSH tunnel — do not change the
bind address to `0.0.0.0`.

To run it in the background so it survives closing the terminal, start it in its
own `tmux` window, or use the in-UI "restart" control once it is running.

## 5. Choose an AI engine

Layaider runs aider through its **native adapter** — it builds the aider
invocation itself from your blueprint: models and options come from a generated
`.aider.conf.yml` in the repo, flags and files are passed on the command line,
and provider API keys are written to a `0600` env file under your state
directory (outside the repo) and sourced into the session, so they never appear
in the process list. No external tooling is required.

Install aider — see the official instructions at
`https://aider.chat`; commonly:

```sh
python3 -m pip install aider-chat
aider --version
```

In the UI's **aider** tab you configure: model strings, role models
(architect / editor / weak) as a **blueprint**, API **keys** (stored at
`~/.layaider/aider/keys.list`, mode `0600`), optional flag sets, and
files to add to context. Launch a blueprint from the **Live** tab; the session
runs in a background `tmux` session named by `session.name` (`la-aider`). You
can attach a terminal to watch it directly:

```sh
tmux attach -t la-aider
```

## 6. project_hooks.py

`project_hooks.py` holds your own, project-specific start/stop macros and
service definitions. It is auto-generated with safe no-op defaults, so a fresh
install has zero coupling to any particular project. Edit it to declare services
that appear under the Processes/System views:

```python
def list_services(ctx):
    return [{"id": "web", "name": "web", "type": "http", "port": 8000}]

def service_status(ctx, service_id):
    # return {"id": ..., "up": bool, "detail": str}
    ...

def start_service(ctx, service_id):
    import subprocess
    if service_id == "web":
        subprocess.Popen(["python3", "-m", "http.server", "8000"],
                         cwd=ctx["git_workspace_root"], shell=False,
                         stdin=subprocess.DEVNULL)
        return {"ok": True, "output": "started"}
    return {"ok": False, "output": "unknown service"}
```

Rule: never build shell command strings — always use `subprocess` argument
arrays with `shell=False`. `ctx` gives you `install_path`, `debian_base_path`,
`git_workspace_root`, `active_repo`, and `session_name`.

## 7. config.json reference

```jsonc
{
  "version": 1,
  "server": { "host": "127.0.0.1", "port": 7070 },
  "paths": {
    "install_path": "",            // Layaider source root
    "debian_base_path": "/",       // proot/Debian root filesystem
    "git_workspace_root": "",      // default managed-projects directory
    "project_hook_file": "project_hooks.py",
    "state_dir": "~/.layaider"     // owned state (keys, history, live log)
  },
  "repos": { "active": "", "extra": [], "scan_depth": 2 },
  "session": {
    "name": "la-aider",            // tmux session name
    "shell": "bash -lic",          // login+interactive wrapper for PATH
    "engine": "aider"              // native aider adapter
  },
  "scan": { "stub_max_lines": 2, "stub_exts": [".js", ".mjs"] }
}
```

`install_path` and `git_workspace_root` are filled at first run; leaving either
empty makes Layaider treat the config as unconfigured and re-run setup.

## 8. Run the tests

```sh
python3 tests/test_security.py
```

Expect the path-validation, repository-discovery, `.gitignore`-guardrail,
init, secret-handling, and session-lifecycle checks to pass. git-dependent and
tmux-dependent tests skip automatically if those tools are missing.

## 9. Troubleshooting

- **UI loads but assets 404** — confirm `public/` sits next to `main.py`; the
  static engine only serves `<install>/public`.
- **Launch says "blueprint not ready"** — the blueprint references a provider
  whose API key is not set; add the key in the aider tab. Local/keyless models
  still need a (possibly dummy) key entry — see `docs/LOCAL_MODELS.md`.
- **Session dies instantly** — the engine binary is not on `PATH` in a login
  shell; confirm `aider` runs in a fresh `bash -lic` shell.
- **Permission error writing the parent `.gitignore`** — Layaider is nested in a
  repo whose root you cannot write (e.g. `/`); add the isolation lines manually
  or move Layaider out of that tree.

## 10. Release checklist (for publishing a fork)

- Add a `LICENSE` file (Layaider ships without one).
- Remove the retired monolith `layaider.py` if present in your tree.
- Run `python3 tests/test_security.py` on-device.
- Confirm no secrets are committed: `config.json` carries none, and
  `~/.layaider` (state, keys) is outside the repo.

## Connecting a remote (GitHub and others)

The Sync tab has a guided **Connect a remote** panel with three methods. Each
builds the correct URL for you and has a **test connection** button (a
read-only `git ls-remote`) so you can confirm credentials before saving.
Required fields are marked; the remote name defaults to `origin` but you can set
your own.

GitHub removed password authentication for git in 2021 — you authenticate with a
token (HTTPS) or an SSH key, not your account password.

### Method 1 — HTTPS + token (simplest)

1. Create a token: a [fine-grained token](https://github.com/settings/personal-access-tokens)
   (give it the target repository, Contents: read & write) — or a
   [classic token](https://github.com/settings/tokens) with the `repo` scope.
   Copy it immediately; GitHub shows it only once.
2. In the panel, fill Owner, Repository, your GitHub username, and the token.
   The URL is assembled as `https://USERNAME:TOKEN@github.com/OWNER/REPO.git` —
   you never type that format yourself.
3. **Test connection** → fix anything it flags → **save remote**.

The token is stored only in this repo's git config on this device. To change
wrong credentials later, just re-enter and save again.

### Method 2 — SSH key (no token, good for repeated use)

1. **show / generate key** creates an Ed25519 key on the device (if one doesn't
   exist) and shows the **public** key.
2. Copy it and add it at [GitHub → SSH keys](https://github.com/settings/keys)
   (New SSH key).
3. Fill Owner + Repository (URL becomes `git@github.com:OWNER/REPO.git`),
   **test connection**, then **save remote**.

### Method 3 — Manual URL (any host)

Paste a complete remote URL (GitHub Enterprise, GitLab, Bitbucket, a private
server, etc.) and save. Use this if you already have the exact URL.

### Higher-level options (not required)

If `gh` (GitHub CLI) is installed, the panel notes you can also run
`gh auth login` in a terminal for a browser-based login; Git Credential Manager
is another option. Layaider doesn't require either, and doesn't use OAuth.

### git identity

Set **git identity** (name + email) in the same tab — commits use it, and a
missing identity can cause pushes to be rejected or mis-attributed.

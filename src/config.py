#!/usr/bin/env python3
# DEV-AWARE: defines dev mode (app_mode) and gates dev-only behavior. Active only
# when the gitignored DEV sentinel contains "true"; otherwise this is a no-op.
"""Layaider configuration and first-time initialization.

Handles config.json read/writes, environment path setup, the interactive
first-run routine, the active-repository .gitignore guardrail, and
auto-generation of the user-owned project_hooks.py file.

All process execution uses subprocess argument arrays with shell=False.
No path defined here is hardcoded to a host layout; every anchor is read
from config.json or established at first run.
"""

import os
import sys
import copy
import json
import shlex
import shutil
import importlib.util
import subprocess
from pathlib import Path

CONFIG_FILENAME = "config.json"

# The app root is the directory that holds config.json: the install path,
# which is the parent of this src/ directory.
DEFAULT_APP_ROOT = Path(__file__).resolve().parent.parent


def _truthy_sentinel(path):
    try:
        if not Path(path).is_file():
            return False
        return Path(path).read_text().strip().lower() not in ("", "0", "false", "no", "off")
    except OSError:
        return False


def dev_available(install_path=None):
    """Whether developer mode is *available* on this install.

    Availability is the gitignored ``DEV`` sentinel (a truthy value, e.g.
    ``true``) in the install root. Because ``DEV`` is never committed, everyone
    who installs Layaider is in user mode automatically; a developer makes dev
    available on their own copy by creating that file. Availability is the outer
    gate and is *only* controllable through the file — the UI can never raise it.
    """
    roots = []
    if install_path:
        roots.append(Path(install_path))
    try:
        if isinstance(_CONFIG_CACHE, dict):
            ip = _CONFIG_CACHE.get("paths", {}).get("install_path")
            if ip:
                roots.append(Path(ip))
    except Exception:
        pass
    roots.append(DEFAULT_APP_ROOT)
    for r in roots:
        try:
            if _truthy_sentinel(Path(r) / "DEV"):
                return True
        except Exception:
            continue
    return False


def _suppress_file():
    """Server-side suppression flag, kept in the state dir (never the repo).

    It must live server-side, not in the browser: the server is what withholds
    the dev diagnostics payload, so suppression has to be visible here to
    faithfully simulate user mode.
    """
    return state_dir() / "dev_suppressed"


def dev_suppressed():
    """Whether dev surfaces are currently suppressed despite being available."""
    try:
        return _truthy_sentinel(_suppress_file())
    except Exception:
        return False


def set_dev_suppressed(flag):
    """Toggle suppression. Only meaningful while dev is available; the API layer
    refuses the action otherwise so the UI can never bootstrap dev from user
    mode. Returns True on success."""
    f = _suppress_file()
    try:
        if flag:
            f.write_text("true\n")
        elif f.exists():
            f.unlink()
    except OSError:
        return False
    return True


def app_mode(install_path=None):
    """Return the *effective* mode: "dev" when dev is available and not
    suppressed, else "user". Mode only gates self-repo behavior and
    developer-only surfaces — never anything a user needs."""
    if dev_available(install_path) and not dev_suppressed():
        return "dev"
    return "user"

DEFAULT_CONFIG = {
    "version": 1,
    "server": {"host": "127.0.0.1", "port": 7070},
    "paths": {
        "install_path": "",
        "debian_base_path": "/",
        "git_workspace_root": "",
        "project_hook_file": "project_hooks.py",
        "state_dir": "~/.layaider",
    },
    "repos": {"active": "", "extra": [], "scan_depth": 2},
    "session": {"name": "la-aider", "shell": "bash -lic", "engine": "aider"},
    "scan": {"stub_max_lines": 2, "stub_exts": [".js", ".mjs"]},
    # Optional, local-only. Captured at first run to assist GitHub Sync setup
    # (prefills the identity + username). Never committed; only stored on-device.
    "identity": {"name": "", "email": "", "github_user": ""},
}

# Idempotency markers for the parent-repository isolation block.
GITIGNORE_BEGIN = "# >>> layaider isolation (auto-added) >>>"
GITIGNORE_END = "# <<< layaider isolation (auto-added) <<<"


class ConfigError(Exception):
    """Raised when configuration input or persistence fails validation."""


# --- config.json read / write ----------------------------------------------

def _clone(obj):
    return copy.deepcopy(obj)


def _merge_defaults(loaded, defaults=None):
    base = _clone(DEFAULT_CONFIG if defaults is None else defaults)
    if not isinstance(loaded, dict):
        return base
    for key, default_val in base.items():
        if key in loaded:
            if isinstance(default_val, dict) and isinstance(loaded[key], dict):
                base[key] = _merge_defaults(loaded[key], default_val)
            else:
                base[key] = loaded[key]
    return base


def load_config(app_root=None):
    """Return (config_dict, configured_bool).

    configured is True only when install_path and git_workspace_root are set,
    which is the signal Step 1.4 uses to decide whether to run first-time init.
    """
    root = Path(app_root) if app_root else DEFAULT_APP_ROOT
    path = root / CONFIG_FILENAME
    if not path.is_file():
        return _clone(DEFAULT_CONFIG), False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _clone(DEFAULT_CONFIG), False
    cfg = _merge_defaults(data)
    configured = bool(cfg["paths"]["install_path"] and cfg["paths"]["git_workspace_root"])
    return cfg, configured


def save_config(config, app_root=None):
    root = Path(app_root) if app_root else DEFAULT_APP_ROOT
    path = root / CONFIG_FILENAME
    try:
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise ConfigError("could not write %s: %s" % (path, exc))
    return str(path)


# --- directory validation (first-run inputs) --------------------------------

def validate_directory(raw, create=True):
    """Expand, resolve, and verify a user-entered directory path.

    Unlike core.safe_path (which confines untrusted paths to a workspace),
    this accepts legitimate absolute install / Debian / workspace roots and
    confirms they are usable: it expands ~ and $VARS, creates the directory
    when requested, and tests read/write access.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ConfigError("empty path")
    expanded = os.path.expanduser(os.path.expandvars(raw.strip()))
    path = Path(expanded).resolve()
    if create:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ConfigError("cannot create %s: %s" % (path, exc))
    if not path.is_dir():
        raise ConfigError("not a directory: %s" % path)
    if not os.access(str(path), os.R_OK | os.W_OK):
        raise ConfigError("no read/write permission: %s" % path)
    return str(path)


# --- active-repository .gitignore guardrail ---------------------------------

def _run_git(args, cwd):
    try:
        return subprocess.run(
            args, cwd=str(cwd), shell=False,
            capture_output=True, text=True, timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _git_toplevel(cwd):
    res = _run_git(["git", "rev-parse", "--show-toplevel"], cwd=cwd)
    if res is not None and res.returncode == 0:
        out = (res.stdout or "").strip()
        return out or None
    return None


def _isolation_block(rel):
    return "\n".join([
        GITIGNORE_BEGIN,
        "/%s/" % str(rel).strip("/"),
        ".layaider/",
        ".aider.conf.yml",
        ".aider.chat.history.md",
        ".aider.input.history",
        GITIGNORE_END,
        "",
    ])


def protect_parent_gitignore(install_path):
    """Append an isolation block to an enclosing repository's .gitignore.

    Runs `git rev-parse --show-toplevel` from inside install_path. If a repo
    strictly above the install path is found (including a root checkout at /),
    Layaider's subtree plus its runtime artifacts are excluded so the parent
    repo never tracks them. The write is idempotent via marker comments and
    never raises: a permission failure (e.g. /.gitignore owned by root) is
    reported, not fatal.
    """
    install = Path(install_path).resolve()
    top = _git_toplevel(install)
    if not top:
        return {"nested": False, "wrote": False, "toplevel": None}
    top_path = Path(top).resolve()
    if top_path == install:
        return {"nested": False, "wrote": False, "toplevel": str(top_path)}
    try:
        rel = install.relative_to(top_path)
    except ValueError:
        return {"nested": False, "wrote": False, "toplevel": str(top_path)}

    gi_path = top_path / ".gitignore"
    existing = ""
    if gi_path.is_file():
        try:
            existing = gi_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return {"nested": True, "wrote": False, "toplevel": str(top_path),
                    "error": str(exc)}
    if GITIGNORE_BEGIN in existing:
        return {"nested": True, "wrote": False, "toplevel": str(top_path),
                "already": True}
    sep = "" if (existing == "" or existing.endswith("\n")) else "\n"
    try:
        gi_path.write_text(existing + sep + "\n" + _isolation_block(rel),
                           encoding="utf-8")
    except OSError as exc:
        return {"nested": True, "wrote": False, "toplevel": str(top_path),
                "error": str(exc)}
    return {"nested": True, "wrote": True, "toplevel": str(top_path),
            "ignored": str(rel)}


# --- project_hooks.py generation --------------------------------------------

def ensure_project_hooks(hook_path):
    """Create project_hooks.py from the default template if it is absent.

    Returns (path, created_bool). The default template declares no services
    and performs no actions, so a fresh install has zero game/server coupling
    and core never crashes on a missing hook file.
    """
    path = Path(hook_path)
    if path.is_file():
        return str(path), False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_PROJECT_HOOKS, encoding="utf-8")
    except OSError as exc:
        raise ConfigError("could not write %s: %s" % (path, exc))
    return str(path), True


# --- first-time initialization ----------------------------------------------

def run_first_time_init(app_root=None, interactive=True, answers=None):
    """Establish the workspace layout and serialize config.json.

    answers: optional dict pre-supplying any of install_path,
    debian_base_path, git_workspace_root. When interactive is False and an
    answer is absent, the documented default is used. This keeps the routine
    drivable from tests without stdin.
    """
    root = Path(app_root).resolve() if app_root else DEFAULT_APP_ROOT
    answers = answers or {}
    cfg = _clone(DEFAULT_CONFIG)

    def ask(key, prompt, default):
        if answers.get(key) is not None:
            return str(answers[key])
        if not interactive:
            return default
        try:
            value = input("%s [%s]: " % (prompt, default)).strip()
        except EOFError:
            value = ""
        return value or default

    install_raw = ask(
        "install_path",
        "Enter Layaider source installation root directory",
        str(root),
    )
    debian_raw = ask(
        "debian_base_path",
        "Enter the absolute host path for the Debian/proot root filesystem",
        "/",
    )
    workspace_raw = ask(
        "git_workspace_root",
        "Enter default target directory for managed Git workspace projects",
        str(Path.home() / "layaider-projects"),
    )

    install_path = validate_directory(install_raw, create=True)
    debian_base = validate_directory(debian_raw, create=False)
    workspace_root = validate_directory(workspace_raw, create=True)

    cfg["paths"]["install_path"] = install_path
    cfg["paths"]["debian_base_path"] = debian_base
    cfg["paths"]["git_workspace_root"] = workspace_root
    cfg["paths"]["state_dir"] = validate_directory(
        cfg["paths"]["state_dir"], create=True)

    # Optional identity capture. Skippable; only assists GitHub Sync setup and is
    # stored locally (never committed). Empty answers (and tests) skip it.
    if interactive and not any(answers.get(k) is not None for k in ("git_name", "git_email", "github_user")):
        print("")
        print("Optional — GitHub details (press Enter to skip any; used only to")
        print("pre-fill Sync setup, stored only on this device, never committed):")
    gname = ask("git_name", "  Your name (for git commits)", "")
    gemail = ask("git_email", "  Your email (for git commits)", "")
    ghuser = ask("github_user", "  Your GitHub username", "")
    cfg["identity"] = {"name": gname, "email": gemail, "github_user": ghuser}
    if (gname or gemail) and shutil.which("git"):
        if gname:
            subprocess.run(["git", "config", "--global", "user.name", gname], shell=False)
        if gemail:
            subprocess.run(["git", "config", "--global", "user.email", gemail], shell=False)

    hook_path = Path(install_path) / cfg["paths"]["project_hook_file"]
    _, hook_created = ensure_project_hooks(hook_path)

    # Self-repo hygiene (isolating Layaider inside an enclosing checkout) is only
    # for people developing Layaider itself. End users install it as an appliance
    # and never push it, so this never runs for them.
    if app_mode(install_path) == "dev":
        guard = protect_parent_gitignore(install_path)
    else:
        guard = {"nested": False, "skipped": "user mode"}

    config_path = save_config(cfg, app_root=install_path)

    if interactive:
        print("")
        print("Layaider configured.")
        print("  config:        %s" % config_path)
        print("  install:       %s" % install_path)
        print("  debian base:   %s" % debian_base)
        print("  workspace:     %s" % workspace_root)
        print("  state dir:     %s" % cfg["paths"]["state_dir"])
        print("  project hooks: %s (%s)" % (
            hook_path, "created" if hook_created else "exists"))
        if guard.get("wrote"):
            print("  parent guard:  isolated %s in %s/.gitignore" % (
                guard["ignored"], guard["toplevel"]))
        elif guard.get("nested") and guard.get("error"):
            print("  parent guard:  nested in %s but .gitignore not writable (%s)" % (
                guard["toplevel"], guard["error"]))
    return cfg


# --- default project_hooks.py template --------------------------------------
# Source of truth for both the auto-generated file and the shipped copy at the
# repository root. Declares no services and no-ops every hook.
DEFAULT_PROJECT_HOOKS = '''#!/usr/bin/env python3
"""Layaider project hooks.

User-owned, project-specific startup/shutdown and service macros.
Auto-generated by Layaider on first run. Safe to edit and extend.

Every function receives `ctx`, a dict of validated runtime values:
    ctx["install_path"]        Layaider source root
    ctx["debian_base_path"]    proot / Debian root filesystem
    ctx["git_workspace_root"]  default managed-projects directory
    ctx["active_repo"]         currently selected repo path (may be "")
    ctx["session_name"]        tmux session Layaider uses for the AI runner

Return shapes are fixed so core can rely on them:
    list_services(ctx)        -> [{"id": str, "name": str, "type": str, "port": int}]
    service_status(ctx, sid)  -> {"id": str, "up": bool, "detail": str}
    start_service(ctx, sid)   -> {"ok": bool, "output": str}
    stop_service(ctx, sid)    -> {"ok": bool, "output": str}
    on_session_start(ctx)     -> {"ok": bool, "output": str}
    on_session_stop(ctx)      -> {"ok": bool, "output": str}

The defaults below declare no services and do nothing, so a fresh install
runs with zero external coupling. Add your own logic as needed.

Process rule: never build shell strings. Use subprocess argument arrays with
shell=False, for example:

    import subprocess
    def start_service(ctx, sid):
        if sid == "web":
            proc = subprocess.Popen(
                ["python3", "-m", "http.server", "8000"],
                cwd=ctx["git_workspace_root"], shell=False,
                stdin=subprocess.DEVNULL,
            )
            return {"ok": True, "output": "started pid %d" % proc.pid}
        return {"ok": False, "output": "unknown service"}
"""


def list_services(ctx):
    return []


def service_status(ctx, service_id):
    return {"id": service_id, "up": False, "detail": ""}


def start_service(ctx, service_id):
    return {"ok": False, "output": "no services defined in project_hooks.py"}


def stop_service(ctx, service_id):
    return {"ok": False, "output": "no services defined in project_hooks.py"}


def on_session_start(ctx):
    return {"ok": True, "output": ""}


def on_session_stop(ctx):
    return {"ok": True, "output": ""}
'''


# --- runtime accessors, repo state, project hooks ---------------------------
# Consumed by the Phase 2 modules (core, git, session, storage, api) in place
# of the legacy global CONFIG dict and module-level repo-state globals.

_CONFIG_CACHE = None
_active_repo = None
_project_hooks = None


def get_config():
    global _CONFIG_CACHE
    if _CONFIG_CACHE is None:
        cfg, _ = load_config()
        _CONFIG_CACHE = cfg
    return _CONFIG_CACHE


def set_config(cfg):
    global _CONFIG_CACHE, _active_repo, _project_hooks
    _CONFIG_CACHE = cfg
    _active_repo = None
    _project_hooks = None


def _expand(value):
    return os.path.expanduser(os.path.expandvars(value)) if value else value


def server_host():
    return get_config()["server"]["host"]


def server_port():
    return int(get_config()["server"]["port"])


def session_name():
    return get_config()["session"]["name"]


def session_shell():
    return shlex.split(get_config()["session"]["shell"] or "bash -lic")


def session_engine():
    # The runner behind the session interface — the native aider adapter.
    return (get_config()["session"].get("engine") or "aider").strip()


def scan_depth():
    return int(get_config()["repos"].get("scan_depth", 2))


def stub_max_lines():
    return int(get_config()["scan"]["stub_max_lines"])


def stub_exts():
    return tuple(get_config()["scan"]["stub_exts"])


def install_path():
    return get_config()["paths"]["install_path"] or str(DEFAULT_APP_ROOT)


def debian_base_path():
    return get_config()["paths"]["debian_base_path"] or "/"


def git_workspace_root():
    return _expand(get_config()["paths"]["git_workspace_root"]) or str(Path.home())


def state_dir():
    path = Path(_expand(get_config()["paths"]["state_dir"]) or str(Path.home() / ".layaider"))
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return path


def public_dir():
    # /public is the sole webroot (frontend moved there in Phase 3). safe_path
    # confines all static requests inside it; if it is missing the static
    # engine returns 404 rather than exposing the install tree.
    return (Path(install_path()) / "public").resolve()


def live_log():
    return state_dir() / "aider_live.log"


def live_meta():
    return state_dir() / "aider_live.meta"


def active_repo_file():
    return state_dir() / "active_repo"


def extra_repos_file():
    return state_dir() / "repos_extra"


def is_git_repo(p):
    try:
        return (Path(p) / ".git").exists()
    except Exception:
        return False


def extra_repos():
    try:
        return [ln.strip() for ln in extra_repos_file().read_text().splitlines() if ln.strip()]
    except Exception:
        return []


def discover_repos():
    seen = []

    def add(p):
        if not p:
            return
        rp = str(Path(p).expanduser())
        if is_git_repo(rp) and rp not in seen:
            seen.append(rp)

    def scan(base, depth):
        if depth < 0:
            return
        try:
            for child in sorted(Path(base).iterdir()):
                if not child.is_dir():
                    continue
                name = child.name
                if name == "node_modules" or name.startswith("."):
                    continue
                if is_git_repo(child):
                    add(str(child))
                else:
                    scan(child, depth - 1)
        except Exception:
            pass

    for p in extra_repos():
        add(p)
    base = git_workspace_root()
    add(base)
    scan(base, scan_depth())
    return [{"path": p, "name": os.path.basename(p.rstrip("/")) or p} for p in seen]


def active_repo():
    global _active_repo
    if _active_repo and is_git_repo(_active_repo):
        return _active_repo
    try:
        saved = active_repo_file().read_text().strip()
        if saved and is_git_repo(saved):
            _active_repo = saved
            return _active_repo
    except Exception:
        pass
    repos = discover_repos()
    _active_repo = repos[0]["path"] if repos else git_workspace_root()
    return _active_repo


def set_active(path):
    global _active_repo
    if not path:
        return False
    rp = str(Path(path).expanduser())
    if not is_git_repo(rp):
        return False
    _active_repo = rp
    if rp not in {r["path"] for r in discover_repos()}:
        ex = extra_repos()
        ex.append(rp)
        try:
            extra_repos_file().write_text("\n".join(ex))
        except Exception:
            pass
    try:
        active_repo_file().write_text(rp)
    except Exception:
        pass
    return True


def forget_repo(path):
    """Drop a repo from Layaider's managed list (files untouched). Clears the
    active selection if it pointed here."""
    global _active_repo
    rp = str(Path(path).expanduser())
    ex = [p for p in extra_repos() if str(Path(p).expanduser()) != rp]
    try:
        extra_repos_file().write_text("\n".join(ex) + ("\n" if ex else ""))
    except Exception:
        pass
    if _active_repo and str(Path(_active_repo).expanduser()) == rp:
        _active_repo = None
        try:
            active_repo_file().unlink()
        except Exception:
            pass
    return True


class _NoopHooks:
    """Fallback used when project_hooks.py is missing or fails to import, so a
    broken hook file degrades gracefully instead of crashing core."""

    @staticmethod
    def list_services(ctx):
        return []

    @staticmethod
    def service_status(ctx, service_id):
        return {"id": service_id, "up": False, "detail": ""}

    @staticmethod
    def start_service(ctx, service_id):
        return {"ok": False, "output": "project_hooks.py unavailable"}

    @staticmethod
    def stop_service(ctx, service_id):
        return {"ok": False, "output": "project_hooks.py unavailable"}

    @staticmethod
    def on_session_start(ctx):
        return {"ok": True, "output": ""}

    @staticmethod
    def on_session_stop(ctx):
        return {"ok": True, "output": ""}


def load_project_hooks():
    global _project_hooks
    if _project_hooks is not None:
        return _project_hooks
    hook_file = Path(install_path()) / get_config()["paths"]["project_hook_file"]
    try:
        ensure_project_hooks(hook_file)
    except ConfigError:
        _project_hooks = _NoopHooks
        return _project_hooks
    try:
        spec = importlib.util.spec_from_file_location(
            "layaider_project_hooks", str(hook_file))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _project_hooks = module
    except Exception:
        _project_hooks = _NoopHooks
    return _project_hooks


def hook_ctx():
    repo = active_repo()
    return {
        "install_path": install_path(),
        "debian_base_path": debian_base_path(),
        "git_workspace_root": git_workspace_root(),
        "active_repo": repo if is_git_repo(repo) else "",
        "session_name": session_name(),
    }


if __name__ == "__main__":
    # Allow running the first-time setup standalone before the Phase 2 server
    # entry point (main.py) exists: python3 src/config.py
    existing_cfg, is_configured = load_config()
    if is_configured and "--force" not in sys.argv:
        print("Already configured. Re-run with --force to reconfigure.")
    else:
        run_first_time_init(interactive=True)

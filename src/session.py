#!/usr/bin/env python3
"""Layaider session abstraction: manages the background tmux session that
hosts the AI runner, captures its output via pipe-pane for SSE resume, and
routes input via send-keys. The launch command is built as an argv list so
no shell layer re-parses it; the engine command is read from config to lay
groundwork for alternative local-engine adapters (guide Step 5).
"""

import os
import re
import time
import json
import shlex
import signal
import subprocess
from pathlib import Path

import config
import storage
from core import sh, sh_full, sh_raw


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _aider_native_inner(idx):
    """Build the native aider launch command for blueprint index `idx`.

    Models and options come from the .aider.conf.yml the launcher already wrote
    to the repo (aider auto-loads it). Flags and files are appended here.
    Provider keys are written to a 0600 env file OUTSIDE the repo (under
    state_dir) and sourced by the login shell, so secrets never appear in the
    process arguments / ps output. Relies only on aider auto-loading
    .aider.conf.yml and reading standard provider env vars.
    """
    eff = storage.blueprint_effective(idx) or {}
    flags = (eff.get("flags") or "").strip()
    files = (eff.get("files") or "").strip()
    bps = storage.read_blueprints()
    env = storage.blueprint_env(bps[idx]) if 0 <= idx < len(bps) else {}

    env_path = config.state_dir() / "aider.env"
    lines = ["%s=%s" % (k, shlex.quote(v)) for k, v in env.items()]
    try:
        env_path.write_text("\n".join(lines) + ("\n" if lines else ""))
        os.chmod(str(env_path), 0o600)
    except OSError:
        pass

    parts = ["aider"]
    if flags:
        parts.append(flags)
    if files:
        parts.append(files)
    aider_cmd = " ".join(parts)
    if env:
        return "set -a; . %s; set +a; exec %s" % (shlex.quote(str(env_path)), aider_cmd)
    return "exec " + aider_cmd


def _ansi_strip(s):
    return _ANSI_RE.sub("", s).replace("\r", "")


def redact_secrets(text):
    text = re.sub(r'(--api-key\s+)\S+', r'\1***', text)
    text = re.sub(r'((?:api[_-]?key|auth[_-]?token|token|secret|password)\s*[=:]\s*)\S+',
                  r'\1***', text, flags=re.IGNORECASE)
    text = re.sub(r'sk-or-v1-[A-Za-z0-9]+', 'sk-or-v1-***', text)
    text = re.sub(r'sk-[A-Za-z0-9]{20,}', 'sk-***', text)
    return text


def read_aider_history():
    p = Path(config.active_repo()) / ".aider.chat.history.md"
    if not p.is_file():
        return {"ok": True, "exists": False, "path": str(p), "text": ""}
    try:
        raw = p.read_text(encoding="utf-8", errors="replace")
        st = p.stat()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "exists": True, "path": str(p),
            "size": st.st_size, "mtime": int(st.st_mtime),
            "text": redact_secrets(raw)}


def _yaml_scalar(s):
    # Mirror the dashboard preview's yamlVal() quoting so the written .aider.conf.yml
    # matches what Preview shows: quote when the value carries ':' or '#', has edge
    # whitespace, or is empty (empty -> "" string rather than a null).
    if s == "" or re.search(r"[:#]", s) or s != s.strip():
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _emit_conf(opts):
    # Minimal YAML for the validated option value types (bool / int / list-of-str / str).
    lines = []
    for k in sorted(opts):
        v = opts[k]
        if isinstance(v, bool):
            lines.append("%s: %s" % (k, "true" if v else "false"))
        elif isinstance(v, int):
            lines.append("%s: %d" % (k, v))
        elif isinstance(v, list):
            lines.append("%s:" % k)
            for it in v:
                lines.append("  - %s" % _yaml_scalar(str(it)))
        else:
            lines.append("%s: %s" % (k, _yaml_scalar(str(v))))
    return "\n".join(lines)


def do_aider_launch(body):
    # Reached only when no session exists yet (the /api/aider/ POST gate 423-locks
    # otherwise), so this never double-launches.
    name = (body.get("blueprint") or "").strip()
    if not name:
        return 400, {"ok": False, "error": "missing blueprint"}
    bps = storage.read_blueprints()
    idx = next((i for i, b in enumerate(bps) if b["name"] == name), -1)
    if idx < 0:
        return 404, {"ok": False, "error": "unknown blueprint '%s'" % name}

    # Readiness backstop — never trust the client; refuse if a needed provider key is absent.
    needs = storage._blueprint_readiness(bps[idx], storage.keys_info_index())
    missing = [n["env"] for n in needs if not n["present"]]
    if not needs or missing:
        why = ("missing keys: " + ", ".join(missing)) if missing else "no model configured"
        return 400, {"ok": False, "error": "blueprint not ready (%s)" % why}

    eff = storage.blueprint_effective(idx)
    # The conf carries the effective options verbatim, including the role models
    # (keys use the conf form: the CLI long name minus '--'). The native aider
    # adapter auto-loads this file from the repo for models/options. pretty is
    # forced off for the live view.
    opts = dict(eff["options"])
    opts["pretty"] = False
    # Force plain line input: prompt_toolkit ("fancy input") reads in raw mode and often
    # ignores a tmux-injected Enter (text echoes but never submits). With fancy input off,
    # aider uses a canonical-mode line reader where the injected Enter submits normally.
    opts["fancy-input"] = False
    conf_dir = Path(config.active_repo())  # the AI runner cd's here
    conf_path = conf_dir / ".aider.conf.yml"
    header = ("# generated by the Layaider launcher for blueprint: %s\n"
              "# models/options load from this file; flags/files (and keys via env) are supplied at launch.\n" % name)
    body_yaml = _emit_conf(opts)
    try:
        conf_path.write_text(header + (body_yaml + "\n" if body_yaml else ""))
    except Exception as e:
        return 500, {"ok": False, "error": "could not write %s: %s" % (conf_path, e)}

    sess = config.session_name()
    # User-owned pre-launch hook (replaces any game/server startup that used to
    # live in core). No-op by default.
    try:
        config.load_project_hooks().on_session_start(config.hook_ctx())
    except Exception:
        pass
    # The native aider adapter is the only engine — Layaider launches aider directly.
    inner = _aider_native_inner(idx)
    # Pass the login+interactive shell wrapper as an argv list so tmux runs it
    # directly with no extra /bin/sh layer re-parsing a concatenated string. The
    # shell program is a trusted config value; the blueprint name is quoted
    # inside `inner` for the login shell that ultimately interprets it. A login
    # shell is required so the engine and aider resolve on PATH as in a normal
    # terminal (a bare pane never sources the shell rc and exits instantly).
    shell_argv = config.session_shell()
    try:
        config.live_log().write_text("")  # fresh capture per launch
    except Exception:
        pass
    ok1, o1 = sh_full(
        ["tmux", "new-session", "-d", "-s", sess, "-c", str(conf_dir)]
        + shell_argv + [inner], cwd="/")
    if not ok1:
        return 500, {"ok": False, "error": "tmux launch failed: " + (o1 or "unknown")}
    # Capture the pane (note: pipe-pane also catches the input echo) so 2b just tails the log.
    sh_full(["tmux", "pipe-pane", "-o", "-t", sess, "cat >> " + shlex.quote(str(config.live_log()))], cwd="/")
    try:
        config.live_meta().write_text(json.dumps({"blueprint": name, "started": int(time.time())}))
    except Exception:
        pass
    return 200, {"ok": True, "session": sess, "blueprint": name,
                 "conf": str(conf_path), "log": str(config.live_log())}


def do_aider_input(body):
    # Send a line to the running aider. Two send-keys calls: the text as a *literal*
    # string (-l, so words like "Enter"/"Up"/"C-c" in the text aren't interpreted as
    # keys), then the Enter key to submit. Passed as argv (no shell) -> injection-safe.
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return 409, {"ok": False, "error": "no live session"}
    text = body.get("text", "")
    if not isinstance(text, str):
        return 400, {"ok": False, "error": "bad text"}
    text = text.replace("\r", "").replace("\n", " ")  # single line; Enter submits
    if text:
        ok1, o1 = sh_full(["tmux", "send-keys", "-t", sess, "-l", "--", text], cwd="/")
        if not ok1:
            return 500, {"ok": False, "error": "send-keys failed: " + (o1 or "")}
    ok2, o2 = sh_full(["tmux", "send-keys", "-t", sess, "Enter"], cwd="/")
    if not ok2:
        return 500, {"ok": False, "error": "send-keys Enter failed: " + (o2 or "")}
    return 200, {"ok": True}


def _proc_cmdline(pid):
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    except OSError:
        return ""


def _proc_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def _aider_pid(sess):
    # Walk descendants of the session pane(s) and return the aider process — the one whose
    # command mentions aider (but isn't a tmux send-keys to it). Starting from our own
    # pane avoids the global pgrep false-positives (state dir and history-file paths).
    out = sh(["tmux", "list-panes", "-t", sess, "-F", "#{pane_pid}"], cwd="/")
    roots = [p.strip() for p in (out or "").splitlines() if p.strip().isdigit()]
    seen, queue = set(), list(roots)
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        kids = sh(["pgrep", "-P", pid], cwd="/")
        for k in (kids or "").split():
            if k.strip().isdigit() and k.strip() not in seen:
                queue.append(k.strip())
        cmd = _proc_cmdline(pid)
        if "aider" in cmd and "send-keys" not in cmd:
            return pid
    return None


def do_aider_interrupt(body):
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return 409, {"ok": False, "error": "no live session"}
    ok, o = sh_full(["tmux", "send-keys", "-t", sess, "C-c"], cwd="/")
    if not ok:
        return 500, {"ok": False, "error": "send-keys C-c failed: " + (o or "")}
    return 200, {"ok": True}


def do_aider_exit(body):
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return 409, {"ok": False, "error": "no live session"}
    ok1, o1 = sh_full(["tmux", "send-keys", "-t", sess, "-l", "--", "/exit"], cwd="/")
    if not ok1:
        return 500, {"ok": False, "error": "send-keys failed: " + (o1 or "")}
    sh_full(["tmux", "send-keys", "-t", sess, "Enter"], cwd="/")
    return 200, {"ok": True}


def do_aider_terminate(body):
    # SIGTERM the aider process directly; if it's wedged and ignores TERM, escalate to KILL.
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return 409, {"ok": False, "error": "no live session"}
    pid = _aider_pid(sess)
    if not pid:
        return 404, {"ok": False, "error": "aider process not found in session"}
    try:
        os.kill(int(pid), signal.SIGTERM)
    except (ProcessLookupError, ValueError, PermissionError) as e:
        return 500, {"ok": False, "error": "SIGTERM failed: %s" % e}
    time.sleep(1.0)
    killed = False
    if _proc_alive(pid):
        try:
            os.kill(int(pid), signal.SIGKILL)
            killed = True
        except OSError:
            pass
    return 200, {"ok": True, "pid": pid, "escalated": killed}


def do_aider_kill(body):
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return 409, {"ok": False, "error": "no live session"}
    ok, o = sh_full(["tmux", "kill-session", "-t", sess], cwd="/")
    if not ok:
        return 500, {"ok": False, "error": "kill-session failed: " + (o or "")}
    try:
        config.load_project_hooks().on_session_stop(config.hook_ctx())
    except Exception:
        pass
    return 200, {"ok": True}


def _tmux_has_session(sess):
    try:
        return subprocess.run(
            ["tmux", "has-session", "-t", sess],
            capture_output=True, timeout=4,
        ).returncode == 0
    except Exception:
        return False


def aider_status():
    # Active iff the dashboard's tmux session exists. This only sees aider that the
    # dashboard launched; an aider run started manually in another pane will not register
    # (accepted tradeoff — has-session is precise where `pgrep -f aider` collided with the
    # state dir and history-file paths). pids are the pane shell pids, kept so
    # the Status page line still has something to show (and useful for the 2d interrupt).
    sess = config.session_name()
    if not _tmux_has_session(sess):
        return {"active": False, "pids": [], "session": sess}
    pids = []
    out = sh(["tmux", "list-panes", "-t", sess, "-F", "#{pane_pid}"], cwd="/")
    if out:
        pids = [p.strip() for p in out.splitlines() if p.strip().isdigit()]
    res = {"active": True, "pids": pids, "session": sess}
    try:  # which blueprint, since when — written at launch
        meta = json.loads(config.live_meta().read_text())
        if isinstance(meta, dict):
            if meta.get("blueprint"):
                res["blueprint"] = meta["blueprint"]
            if isinstance(meta.get("started"), int):
                res["started"] = meta["started"]
    except Exception:
        pass
    return res

#!/usr/bin/env python3
"""Layaider native server manager.

Registry + triage state for internal Termux/Debian servers. Lifecycle
(start/stop/restart/status) and discovery are layered on in later phases.

Layaider owns its state entirely under config.state_dir() and never reads or
writes any other tool's configuration or state files:
    servers.json            the registry + manager settings
    servers/<id>/           per-managed-server log + pidfile

All process control uses subprocess argv arrays with shell=False.
"""

import os
import re
import json
import time
import signal
import socket
import subprocess
import urllib.request

import config

# Triage buckets (see SERVERS_PLAN.md):
#   unreviewed  discovered, not yet triaged (default landing bucket)
#   watch       live status only; Layaider never starts/stops/configures it
#   managed     full lifecycle
#   ignored     do-not-manage; hidden, kept in an editable list
STATES = ("unreviewed", "watch", "managed", "ignored")

# Presets that pre-fill command/args; every field stays user-editable (no
# hardcoded launch lines).
TYPES = ("static-http", "python-app", "node", "ssh", "generic")

DEFAULT_HEALTH = {"type": "none", "path": "/", "port": None}   # none | port | http
DEFAULT_SETTINGS = {"hideIgnoredCount": False}

# Fields a caller may set via add/update (everything else is manager-owned).
_EDITABLE = ("name", "type", "host", "port", "directory", "command", "args",
             "env", "match", "stop", "autostart", "health", "notes", "color",
             "pillLabel", "state")


def registry_path():
    return config.state_dir() / "servers.json"


def servers_dir():
    return config.state_dir() / "servers"


def _now():
    return int(time.time())


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _valid_port(p):
    return isinstance(p, int) and 1 <= p <= 65535


# ---- live status helpers (Phase 2) ----------------------------------------
# All process control is argv + shell=False. Status is computed cheaply on each
# snapshot; the HTTP/port health probe is bounded by a short timeout so a hung
# server can never block the poll.

_PROBE_TIMEOUT = 0.4


def _server_dir(sid):
    return servers_dir() / str(sid)


def _pidfile(sid):
    return _server_dir(sid) / "pid"


def _logfile(sid):
    return _server_dir(sid) / "log"


def _read_pid(sid):
    try:
        return int(_pidfile(sid).read_text().strip())
    except Exception:
        return None


def _alive(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        # On Linux/Termux, /proc is the reliable check (kill may EPERM).
        return os.path.exists("/proc/%d" % pid)


def _proc_uptime(pid):
    try:
        from core import read_text
        up = float(read_text("/proc/uptime").split()[0])
        start = int(read_text("/proc/%d/stat" % pid).split()[21])
        return int(up - start / os.sysconf("SC_CLK_TCK"))
    except Exception:
        return None


def _listening_ports():
    from core import sh, read_text
    ports = set()
    out = sh(["ss", "-ltn"], cwd="/")
    if out:
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[0].upper() == "LISTEN":
                p = parts[3].rsplit(":", 1)[-1]
                if p.isdigit():
                    ports.add(int(p))
    # Fall back to procfs whenever ss is missing, blocked (netlink under proot),
    # or returns only a header — common in Termux/proot environments.
    if not ports:
        for fn in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                for line in read_text(fn).splitlines()[1:]:
                    f = line.split()
                    if len(f) >= 4 and f[3] == "0A":
                        ports.add(int(f[1].split(":")[1], 16))
            except Exception:
                pass
    # The dashboard's own port is known-listening; never miss it.
    try:
        ports.add(config.server_port())
    except Exception:
        pass
    return ports


def _port_open(host, port):
    if not _valid_port(port):
        return False
    try:
        with socket.create_connection((host or "127.0.0.1", port), _PROBE_TIMEOUT):
            return True
    except OSError:
        return False


def _http_ok(host, port, path):
    if not _valid_port(port):
        return False
    url = "http://%s:%d%s" % (host or "127.0.0.1", port, path or "/")
    try:
        with urllib.request.urlopen(url, timeout=_PROBE_TIMEOUT) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def compute_status(rec, listening=None):
    """Live status for one record. Detection layers: managed pidfile -> port
    listening -> process pattern. Health (optional) confirms it actually serves."""
    if listening is None:
        listening = _listening_ports()
    sid = rec.get("id")
    match = rec.get("match") or {}
    by = match.get("by", "port")
    pid, up = None, False

    mpid = _read_pid(sid)
    if mpid and _alive(mpid):
        pid, up = mpid, True
    elif by == "pattern" and match.get("pattern"):
        from core import sh
        out = sh(["pgrep", "-f", str(match.get("pattern"))], cwd="/")
        cand = [int(x) for x in (out or "").split() if x.isdigit() and int(x) != os.getpid()]
        if cand:
            pid, up = cand[0], True
    elif rec.get("port") and rec["port"] in listening:
        up = True

    health = "na"
    htype = (rec.get("health") or {}).get("type", "none")
    if up and htype != "none":
        hport = (rec.get("health") or {}).get("port") or rec.get("port")
        if htype == "http":
            health = "ok" if _http_ok(rec.get("host"), hport, (rec.get("health") or {}).get("path")) else "down"
        elif htype == "port":
            health = "ok" if _port_open(rec.get("host"), hport) else "down"

    return {"up": up, "pid": pid, "uptime": _proc_uptime(pid) if pid else None, "health": health}


def _load():
    try:
        data = json.loads(registry_path().read_text())
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    servers = data.get("servers")
    settings = data.get("settings")
    out = {
        "servers": [r for r in servers if isinstance(r, dict)] if isinstance(servers, list) else [],
        "settings": dict(DEFAULT_SETTINGS),
    }
    if isinstance(settings, dict):
        out["settings"].update({k: settings[k] for k in DEFAULT_SETTINGS if k in settings})
    return out


def _save(data):
    p = registry_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        os.replace(tmp, p)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
        return True
    except Exception:
        return False


def _gen_id(existing):
    base, i = _now(), 0
    while True:
        sid = "s%d" % (base + i)
        if sid not in existing:
            return sid
        i += 1


def _norm(r):
    """Coerce a stored or incoming dict into the full record shape, with safe
    defaults. Unknown keys are dropped; manager-owned keys are preserved."""
    args = r.get("args")
    env = r.get("env")
    match = r.get("match")
    stop = r.get("stop")
    health = r.get("health")
    return {
        "id": str(r.get("id") or ""),
        "name": str(r.get("name") or "").strip()[:120],
        "state": r.get("state") if r.get("state") in STATES else "unreviewed",
        "type": r.get("type") if r.get("type") in TYPES else "generic",
        "host": (str(r.get("host") or "").strip() or "127.0.0.1")[:120],
        "port": _int(r.get("port")),
        "directory": str(r.get("directory") or "").strip(),
        "command": str(r.get("command") or "").strip(),
        "args": [str(a) for a in args] if isinstance(args, list) else [],
        "env": {str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {},
        "match": match if isinstance(match, dict) else {"by": "port"},
        "stop": stop if isinstance(stop, dict) else {"by": "pid"},
        "autostart": bool(r.get("autostart")),
        "health": health if isinstance(health, dict) else dict(DEFAULT_HEALTH),
        "logfile": r.get("logfile") or None,
        "notes": str(r.get("notes") or "")[:1000],
        "color": str(r.get("color") or "")[:16],
        "pillLabel": str(r.get("pillLabel") or "")[:40],
        "discovered": r.get("discovered") if isinstance(r.get("discovered"), dict) else None,
        "lastSeen": _int(r.get("lastSeen")) or None,
        "self": bool(r.get("self")),
    }


def list_servers():
    return [_norm(r) for r in _load()["servers"]]


def _find(servers, sid):
    for i, r in enumerate(servers):
        if str(r.get("id")) == str(sid):
            return i
    return -1


def counts(servers):
    c = {s: 0 for s in STATES}
    for r in servers:
        st = r.get("state") if r.get("state") in STATES else "unreviewed"
        c[st] += 1
    return c


def snapshot():
    """Everything the Servers tab needs: the registry with live status per
    server, per-state counts, and manager settings."""
    data = _load()
    servers = [_norm(r) for r in data["servers"]]
    listening = _listening_ports()
    for r in servers:
        if r["state"] == "ignored":
            r["status"] = {"up": False, "pid": None, "uptime": None, "health": "na"}
        else:
            r["status"] = compute_status(r, listening)
    return {"servers": servers, "counts": counts(servers), "settings": data["settings"]}


# ---- writes ----------------------------------------------------------------

def add_server(values, default_state="managed"):
    data = _load()
    servers = data["servers"]
    rec = _norm({k: values.get(k) for k in _EDITABLE if k in values})
    if not rec["name"]:
        return 400, {"ok": False, "error": "name required"}
    if rec["port"] and not _valid_port(rec["port"]):
        return 400, {"ok": False, "error": "port must be 1-65535"}
    if values.get("state") not in STATES:
        rec["state"] = default_state
    rec["id"] = _gen_id({str(r.get("id")) for r in servers})
    servers.append(rec)
    if not _save(data):
        return 500, {"ok": False, "error": "could not write registry"}
    return 200, {"ok": True, "server": rec}


def update_server(sid, values):
    data = _load()
    servers = data["servers"]
    i = _find(servers, sid)
    if i < 0:
        return 404, {"ok": False, "error": "not found"}
    merged = dict(servers[i])
    for k in _EDITABLE:
        if k in values:
            merged[k] = values[k]
    rec = _norm(merged)
    rec["id"] = str(servers[i].get("id"))         # id is immutable
    if not rec["name"]:
        return 400, {"ok": False, "error": "name required"}
    if rec["port"] and not _valid_port(rec["port"]):
        return 400, {"ok": False, "error": "port must be 1-65535"}
    servers[i] = rec
    if not _save(data):
        return 500, {"ok": False, "error": "could not write registry"}
    return 200, {"ok": True, "server": rec}


def delete_server(sid):
    data = _load()
    servers = data["servers"]
    i = _find(servers, sid)
    if i < 0:
        return 404, {"ok": False, "error": "not found"}
    servers.pop(i)
    if not _save(data):
        return 500, {"ok": False, "error": "could not write registry"}
    return 200, {"ok": True}


def set_state(ids, state):
    """Triage move for one or many servers (bulk-friendly)."""
    if state not in STATES:
        return 400, {"ok": False, "error": "bad state"}
    if not isinstance(ids, list):
        ids = [ids]
    want = {str(x) for x in ids}
    data = _load()
    n = 0
    for r in data["servers"]:
        if str(r.get("id")) in want:
            r["state"] = state
            n += 1
    if not _save(data):
        return 500, {"ok": False, "error": "could not write registry"}
    return 200, {"ok": True, "count": n, "state": state}


def update_settings(values):
    data = _load()
    for k in DEFAULT_SETTINGS:
        if k in values:
            data["settings"][k] = bool(values[k]) if isinstance(DEFAULT_SETTINGS[k], bool) else values[k]
    if not _save(data):
        return 500, {"ok": False, "error": "could not write registry"}
    return 200, {"ok": True, "settings": data["settings"]}


# ---- lifecycle (Phase 2) ---------------------------------------------------
# Only `managed` servers may be controlled. `watch` is status-only; the
# dashboard itself (self) is never controllable.

def _get(sid):
    data = _load()
    return data, _find(data["servers"], sid)


def _clear_pid(sid):
    try:
        _pidfile(sid).unlink()
    except OSError:
        pass


def _controllable(rec):
    if rec["state"] != "managed":
        return "only managed servers can be controlled"
    if rec.get("self"):
        return "refusing to control the Layaider dashboard"
    return None


def start_server(sid):
    data, i = _get(sid)
    if i < 0:
        return 404, {"ok": False, "error": "not found"}
    rec = _norm(data["servers"][i])
    why = _controllable(rec)
    if why:
        return 400, {"ok": False, "error": why}
    if compute_status(rec)["up"]:
        return 200, {"ok": True, "output": "already running"}
    cmd = rec.get("command")
    if not cmd:
        return 400, {"ok": False, "error": "no command set for this server"}
    cwd = os.path.expanduser(rec["directory"]) if rec["directory"] else None
    if cwd and not os.path.isdir(cwd):
        return 400, {"ok": False, "error": "directory does not exist: %s" % cwd}
    argv = [cmd] + list(rec.get("args") or [])
    env = dict(os.environ)
    env.update(rec.get("env") or {})
    try:
        _server_dir(sid).mkdir(parents=True, exist_ok=True)
        logf = open(_logfile(sid), "ab")
    except Exception as e:
        return 200, {"ok": False, "output": "log open failed: %s" % e}
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, shell=False,
                                stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                start_new_session=True)
    except Exception as e:
        logf.close()
        return 200, {"ok": False, "output": str(e)}
    logf.close()
    try:
        _pidfile(sid).write_text(str(proc.pid))
    except OSError:
        pass
    data["servers"][i]["logfile"] = str(_logfile(sid))
    _save(data)
    return 200, {"ok": True, "pid": proc.pid}


def stop_server(sid):
    data, i = _get(sid)
    if i < 0:
        return 404, {"ok": False, "error": "not found"}
    rec = _norm(data["servers"][i])
    why = _controllable(rec)
    if why:
        return 400, {"ok": False, "error": why}
    pid = compute_status(rec)["pid"] or _read_pid(sid)
    if pid == os.getpid():
        return 400, {"ok": False, "error": "refusing to kill Layaider"}
    if not pid:
        stop = rec.get("stop") or {}
        if stop.get("by") == "pattern" and stop.get("pattern"):
            from core import sh
            sh(["pkill", "-f", str(stop.get("pattern"))], cwd="/")
            _clear_pid(sid)
            return 200, {"ok": True, "output": "signalled by pattern"}
        return 200, {"ok": False, "output": "not running"}
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception as e:
        return 200, {"ok": False, "output": str(e)}
    _clear_pid(sid)
    return 200, {"ok": True, "output": "stopped pid %d" % pid}


def restart_server(sid):
    stop_server(sid)
    time.sleep(0.6)
    return start_server(sid)


def server_status(sid):
    data, i = _get(sid)
    if i < 0:
        return 404, {"ok": False, "error": "not found"}
    return 200, {"ok": True, "status": compute_status(_norm(data["servers"][i]))}


def pill_summary():
    """Cheap up/down for colour-allocated managed/watch servers — fed into
    build_status() for the header pills (no separate fetch needed)."""
    data = _load()
    listening = _listening_ports()
    out = []
    for r in data["servers"]:
        rec = _norm(r)
        if rec["state"] not in ("managed", "watch") or not rec["color"]:
            continue
        out.append({"name": rec["name"], "port": rec["port"], "color": rec["color"],
                    "pillLabel": rec["pillLabel"], "up": compute_status(rec, listening)["up"]})
    return out


def boot():
    """Start managed servers flagged autostart that aren't already up. Called
    once when the Layaider dashboard starts. Never starts watch/ignored/self."""
    data = _load()
    listening = _listening_ports()
    started = []
    for r in data["servers"]:
        rec = _norm(r)
        if rec["state"] == "managed" and rec["autostart"] and not rec.get("self"):
            if not compute_status(rec, listening)["up"]:
                _, res = start_server(rec["id"])
                if res.get("ok"):
                    started.append(rec["id"])
    return started


def read_logs(sid, cap=20000):
    try:
        blob = _logfile(sid).read_bytes()
    except Exception:
        return 200, {"ok": True, "log": ""}
    if len(blob) > cap:
        blob = blob[-cap:]
    return 200, {"ok": True, "log": blob.decode("utf-8", "replace")}


# ---- discovery (Phase 3) ---------------------------------------------------
# Sweep the system's listening sockets and surface anything not already in the
# registry as `unreviewed`. Triage is sticky: known servers (any state, incl.
# ignored) are never re-added — only their lastSeen is refreshed.

def _proc_cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            parts = f.read().split(b"\x00")
        return [p.decode("utf-8", "replace") for p in parts if p]
    except Exception:
        return []


def _proc_cwd(pid):
    try:
        return os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        return None


def _ss_listeners():
    """[{port, pid, proc}] for TCP listeners. Uses `ss -ltnp`; falls back to
    port-only (via procfs) when ss is missing/blocked or returns no rows — common
    under Termux/proot, where the dashboard's own port is still surfaced."""
    from core import sh
    res, seen = [], set()
    out = sh(["ss", "-ltnp"], cwd="/")
    if out:
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 4 or parts[0].upper() != "LISTEN":
                continue
            ps = parts[3].rsplit(":", 1)[-1]
            if not ps.isdigit():
                continue
            port = int(ps)
            if port in seen:
                continue
            seen.add(port)
            pid, proc = None, ""
            m = re.search(r'\(\("([^"]+)",pid=(\d+)', line)
            if m:
                proc, pid = m.group(1), int(m.group(2))
            res.append({"port": port, "pid": pid, "proc": proc})
    if not res:
        res = [{"port": p, "pid": None, "proc": ""} for p in sorted(_listening_ports())]
    return res


def _guess_type(cmdline, proc):
    s = (" ".join(cmdline) + " " + (proc or "")).lower()
    if "sshd" in s:
        return "ssh"
    if "http.server" in s:
        return "static-http"
    if "node" in s:
        return "node"
    if "main.py" in s or "python" in s:
        return "python-app"
    return "generic"


# Probed when kernel socket tables are unreadable (no ss, /proc/net/tcp denied —
# common under Termux/proot). Union'd with ports parsed from process command
# lines, the registry, and the dashboard port before probing.
COMMON_PORTS = [
    80, 443, 1234, 2222, 3000, 3001, 4000, 4200, 5000, 5050, 5173, 5432, 6006,
    6379, 7070, 8000, 8008, 8050, 8080, 8081, 8088, 8443, 8501, 8888, 8022,
    9000, 9090, 11434, 3306, 27017, 5984,
]
_PORT_PATTERNS = [
    re.compile(r'--?port[=\s]+(\d{2,5})', re.I),     # --port 8000 / --port=8000
    re.compile(r'\bhttp\.server\s+(\d{2,5})'),       # python -m http.server 8000
    re.compile(r'\B-p[=\s]?(\d{2,5})\b'),            # -p 8022
    re.compile(r':(\d{2,5})\b'),                     # host:8000 / :8000 (loose; probe confirms)
]


def _proc_list():
    out = []
    try:
        pids = [e for e in os.listdir("/proc") if e.isdigit()]
    except Exception:
        return out
    for pid in pids:
        argv = _proc_cmdline(int(pid))
        if argv:
            out.append({"pid": int(pid), "argv": argv, "cmd": " ".join(argv)})
    return out


def _extract_ports(cmd):
    ports = set()
    for rx in _PORT_PATTERNS:
        for m in rx.finditer(cmd):
            try:
                v = int(m.group(1))
            except ValueError:
                continue
            if _valid_port(v):
                ports.add(v)
    return ports


def _probe(port, timeout=0.25):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout):
            return True
    except OSError:
        return False


def _probe_ports(cands):
    return {p for p in cands if _valid_port(p) and _probe(p)}


def _owner_for_port(procs, port):
    """The process whose command line names this port (best-effort)."""
    sp = re.compile(r'(?<!\d)' + str(port) + r'(?!\d)')
    for p in procs:
        if sp.search(p["cmd"]):
            return p
    return None


def discover():
    data = _load()
    servers = data["servers"]
    known_ports = {_int(r.get("port")) for r in servers if _int(r.get("port"))}
    try:
        dash_port = config.server_port()
    except Exception:
        dash_port = 0
    now = _now()
    procs = _proc_list()

    # Build candidate ports from every source, then CONFIRM by connecting — the
    # connect works with no ss and no /proc/net/tcp access.
    cand = set(COMMON_PORTS)
    for p in procs:
        cand |= _extract_ports(p["cmd"])
    cand |= {L["port"] for L in _ss_listeners()}
    cand |= {_int(r.get("port")) for r in servers if _int(r.get("port"))}
    if dash_port:
        cand.add(dash_port)
    cand = {p for p in cand if _valid_port(p)}
    open_ports = _probe_ports(cand)

    added = []
    for port in sorted(open_ports):
        if port in known_ports:
            for r in servers:
                if _int(r.get("port")) == port:
                    r["lastSeen"] = now
            continue
        is_self = bool(dash_port and port == dash_port)
        owner = (next((p for p in procs if p["pid"] == os.getpid()), None) if is_self
                 else _owner_for_port(procs, port))
        argv = owner["argv"] if owner else []
        name = ("Layaider dashboard" if is_self
                else (argv[0].rsplit("/", 1)[-1] if argv else ("port %d" % port)))
        rec = _norm({
            "name": name,
            "state": "watch" if is_self else "unreviewed",
            "type": "generic" if is_self else _guess_type(argv, name),
            "host": "127.0.0.1",
            "port": port,
            "directory": (_proc_cwd(owner["pid"]) or "") if owner else "",
            "command": argv[0] if argv else "",
            "args": argv[1:] if len(argv) > 1 else [],
            "match": {"by": "port"},
            "discovered": {"pid": owner["pid"] if owner else None,
                           "cmd": owner["cmd"][:300] if owner else "",
                           "port": port, "ts": now},
            "lastSeen": now,
            "self": is_self,
        })
        rec["id"] = _gen_id({str(r.get("id")) for r in servers})
        servers.append(rec)
        known_ports.add(port)
        added.append(rec)
    _save(data)
    return 200, {"ok": True, "added": len(added), "servers": added,
                 "scanned": len(cand), "open": sorted(open_ports)}


# ---- HTTP dispatch ---------------------------------------------------------

def do_servers(action, body):
    body = body or {}
    if action == "add":
        return add_server(body.get("values") or body)
    if action == "update":
        return update_server(body.get("id"), body.get("values") or body)
    if action == "delete":
        return delete_server(body.get("id"))
    if action == "set-state":
        return set_state(body.get("ids", body.get("id")), body.get("state"))
    if action == "settings":
        return update_settings(body.get("settings") or body)
    if action == "start":
        return start_server(body.get("id"))
    if action == "stop":
        return stop_server(body.get("id"))
    if action == "restart":
        return restart_server(body.get("id"))
    if action == "status":
        return server_status(body.get("id"))
    if action == "logs":
        return read_logs(body.get("id"))
    if action == "discover":
        return discover()
    if action == "port-check":
        return port_check(body.get("port"))
    if action == "port-suggest":
        return port_suggest()
    return 400, {"ok": False, "error": "unknown action"}


def port_check(port):
    port = _int(port)
    if not _valid_port(port):
        return 400, {"ok": False, "error": "port must be 1-65535"}
    known = {_int(r.get("port")) for r in _load()["servers"]}
    return 200, {"ok": True, "port": port,
                 "free": port not in _listening_ports() and port not in known}


def port_suggest():
    listening = _listening_ports()
    known = {_int(r.get("port")) for r in _load()["servers"]}
    for p in range(8000, 8200):
        if p not in listening and p not in known:
            return 200, {"ok": True, "port": p}
    return 200, {"ok": True, "port": 0}

#!/usr/bin/env python3
# DEV-AWARE: build_status() emits an extra "dev" diagnostics block only when
# app_mode is "dev". In user mode that block is never produced or sent.
"""Layaider host-metrics drivers and status orchestration, plus the optional
project_hooks service bridge. The native server manager lives in servers.py.
All process control uses subprocess argv arrays with shell=False; the
self-restart path spawns a detached python process (no shell).
"""

import os
import sys
import time
import signal
import subprocess
from pathlib import Path

import config
import git
import session
import storage
import servers
from core import read_text, probe_port, sh, safe_path


def _hook_services():
    hooks = config.load_project_hooks()
    ctx = config.hook_ctx()
    out = []
    try:
        services = hooks.list_services(ctx) or []
    except Exception:
        return out
    for s in services:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id", ""))
        entry = {"id": sid, "name": s.get("name", sid),
                 "type": s.get("type", ""), "port": s.get("port", 0)}
        try:
            st = hooks.service_status(ctx, sid) or {}
            entry["up"] = bool(st.get("up"))
            entry["detail"] = st.get("detail", "")
        except Exception:
            entry["up"] = False
            entry["detail"] = ""
        out.append(entry)
    return out


def system_status():
    try:
        uptime = float(read_text("/proc/uptime").split()[0])
    except Exception:
        uptime = 0.0
    mem_total = mem_avail = 0
    for line in read_text("/proc/meminfo").splitlines():
        if line.startswith("MemTotal:"):
            mem_total = int(line.split()[1]) * 1024
        elif line.startswith("MemAvailable:"):
            mem_avail = int(line.split()[1]) * 1024
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except Exception:
        load = [0, 0, 0]
    return {
        "uptime": uptime, "load": load, "cpus": os.cpu_count() or 1,
        "memUsed": mem_total - mem_avail, "memTotal": mem_total,
    }


def disk_status():
    try:
        u = shutil.disk_usage(config.active_repo())
        cap = f"{round(u.used / u.total * 100)}%" if u.total else "-"
        return {"total": u.total, "used": u.used, "capacity": cap}
    except Exception:
        return None


def _meminfo():
    d = {}
    for line in read_text("/proc/meminfo").splitlines():
        parts = line.split(":")
        if len(parts) == 2:
            num = parts[1].split()
            if num and num[0].isdigit():
                d[parts[0]] = int(num[0]) * 1024
    total = d.get("MemTotal", 0)
    avail = d.get("MemAvailable", d.get("MemFree", 0))
    return {"total": total, "used": total - avail, "avail": avail,
            "swapTotal": d.get("SwapTotal", 0), "swapFree": d.get("SwapFree", 0)}


def _disks():
    out, seen = [], set()
    for path in ["/", str(Path.home()), config.active_repo()]:
        try:
            u = shutil.disk_usage(path)
        except Exception:
            continue
        key = (u.total, u.used)
        if key in seen:
            continue
        seen.add(key)
        out.append({"path": path, "total": u.total, "used": u.used, "free": u.free})
    return out


def _proc_runtime(pid):
    try:
        up = float(read_text("/proc/uptime").split()[0])
        fields = read_text("/proc/%s/stat" % pid).split()
        start = int(fields[21])
        hz = os.sysconf("SC_CLK_TCK")
        return int(up - start / hz)
    except Exception:
        return None


def _proc_cwd(pid):
    try:
        return os.readlink("/proc/%s/cwd" % pid)
    except Exception:
        return None


def aider_detail():
    out = sh(["pgrep", "-af", "aider"], cwd="/")
    procs = []
    if out:
        for line in out.splitlines():
            parts = line.split(" ", 1)
            if len(parts) < 2 or not parts[0].isdigit():
                continue
            pid, cmd = parts[0], parts[1]
            if "pgrep" in cmd:
                continue
            procs.append({"pid": int(pid), "cmd": cmd[:300],
                          "runtime": _proc_runtime(pid), "cwd": _proc_cwd(pid)})
    return {"active": len(procs) > 0, "procs": procs}


def listening_ports():
    ports = set()
    out = sh(["ss", "-ltn"], cwd="/")
    if out:
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[0].upper() == "LISTEN":
                p = parts[3].rsplit(":", 1)[-1]
                if p.isdigit():
                    ports.add(int(p))
    # ss can be missing/blocked or header-only under Termux/proot — fall back to
    # procfs whenever it yielded nothing, and always include our own port.
    if not ports:
        for fn in ["/proc/net/tcp", "/proc/net/tcp6"]:
            try:
                for line in read_text(fn).splitlines()[1:]:
                    f = line.split()
                    if len(f) >= 4 and f[3] == "0A":
                        ports.add(int(f[1].split(":")[1], 16))
            except Exception:
                pass
    try:
        ports.add(config.server_port())
    except Exception:
        pass
    return sorted(ports)


def system_info():
    try:
        uptime = float(read_text("/proc/uptime").split()[0])
    except Exception:
        uptime = 0.0
    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except Exception:
        load = [0, 0, 0]
    return {
        "uptime": uptime, "load": load, "cpus": os.cpu_count() or 1,
        "mem": _meminfo(), "disks": _disks(),
        "aider": aider_detail(), "servers": _hook_services(),
        "ports": listening_ports(), "dashPid": os.getpid(),
    }


def system_procs(n=30):
    procs = []
    try:
        pids = [e for e in os.listdir("/proc") if e.isdigit()]
    except Exception:
        return procs
    for pid in pids:
        try:
            status = read_text("/proc/%s/status" % pid)
            name, rss = "", 0
            for line in status.splitlines():
                if line.startswith("Name:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("VmRSS:"):
                    rss = int(line.split()[1]) * 1024
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
            procs.append({"pid": int(pid), "name": name, "rss": rss, "cmd": (cmd or name)[:200]})
        except Exception:
            continue
    procs.sort(key=lambda p: -p["rss"])
    return procs[:n]


def list_docs():
    """Available in-app docs: README plus docs/*.md under the install dir."""
    root = Path(config.install_path())
    out = []
    if (root / "README.md").is_file():
        out.append({"path": "README.md", "title": "README"})
    d = root / "docs"
    if d.is_dir():
        for p in sorted(d.glob("*.md")):
            out.append({"path": "docs/" + p.name, "title": p.stem})
    return out


def read_doc(rel):
    """Read a single doc, confined to README.md or docs/*.md under the install
    dir (read-only; users edit the files directly elsewhere)."""
    rel = (rel or "").strip()
    ok = (rel == "README.md") or (rel.startswith("docs/") and rel.endswith(".md") and rel.count("/") == 1)
    if not ok:
        return None
    p = safe_path(str(Path(config.install_path())), rel)
    if p is None or not p.is_file():
        return None
    try:
        return p.read_text()[:500000]
    except OSError:
        return None


def build_status():
    # serverPills come from the native server manager (servers.py); the optional
    # "servers" list still reflects any project_hooks-declared services.
    st = {
        "time": int(time.time() * 1000),
        "mode": config.app_mode(),
        "devAvailable": config.dev_available(),
        "devSuppressed": config.dev_suppressed(),
        "system": system_status(), "disk": disk_status(),
        "aider": session.aider_status(),
        "servers": _hook_services(), "git": git.git_status(), "stubs": git.stub_scan(),
    }
    try:
        st["serverPills"] = servers.pill_summary()   # native server-manager pills
    except Exception:
        st["serverPills"] = []
    # The dev diagnostics block is keyed on *effective* mode, so it is withheld
    # whenever dev is suppressed or unavailable — devAvailable/devSuppressed above
    # only tell the UI whether to show the (non-sensitive) availability affordance.
    if st["mode"] == "dev":
        try:
            st["dev"] = {
                "install": config.install_path(),
                "state_dir": str(config.state_dir()),
                "workspace": config.git_workspace_root(),
                "active_repo": config.active_repo(),
                "engine": config.session_engine(),
            }
        except Exception:
            st["dev"] = {}
    return st


_RELAUNCH_SRC = (
    "import os, sys, time, subprocess\n"
    "pid = int(sys.argv[1]); py = sys.argv[2]; script = sys.argv[3]\n"
    "cwd = sys.argv[4]; log = sys.argv[5]\n"
    "time.sleep(1)\n"
    "try:\n"
    "    os.kill(pid, 15)\n"
    "except Exception:\n"
    "    pass\n"
    "time.sleep(1)\n"
    "lf = open(log, 'ab')\n"
    "subprocess.Popen([py, script], cwd=cwd, start_new_session=True,\n"
    "                 stdin=subprocess.DEVNULL, stdout=lf, stderr=lf)\n"
)


def do_system(action, body):
    if action == "kill":
        try:
            pid = int(body.get("pid"))
        except (TypeError, ValueError):
            return 400, {"ok": False, "error": "bad pid"}
        if pid == os.getpid():
            return 400, {"ok": False, "error": "refusing to kill Layaider"}
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action in ("server-start", "server-stop"):
        sid = str(body.get("id", ""))
        hooks = config.load_project_hooks()
        ctx = config.hook_ctx()
        try:
            if action == "server-start":
                res = hooks.start_service(ctx, sid)
            else:
                res = hooks.stop_service(ctx, sid)
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        if not isinstance(res, dict):
            res = {"ok": False, "output": "hook returned no result"}
        return 200, {"ok": bool(res.get("ok")), "output": res.get("output", "")}
    if action in ("server-config", "server-meta"):
        # Superseded by the native server manager — see /api/servers/* (servers.py).
        return 400, {"ok": False,
                     "error": "use the Servers tab (/api/servers)"}
    if action in ("dev-suppress", "dev-enable"):
        # Suppression toggles dev surfaces off/on *within* an available install.
        # Availability (the DEV sentinel) is file-only and is never raised here,
        # so the UI can flip suppression both ways but can never bootstrap dev
        # from user mode: if dev isn't available, both actions are refused.
        if not config.dev_available():
            return 403, {"ok": False, "error": "dev mode not available",
                         "detail": "set the DEV sentinel file to enable it"}
        ok = config.set_dev_suppressed(action == "dev-suppress")
        return 200, {"ok": ok, "mode": config.app_mode(),
                     "devAvailable": True,
                     "devSuppressed": config.dev_suppressed()}
    if action == "restart":
        script = os.path.abspath(sys.argv[0])
        cwd = config.install_path() or os.getcwd()
        log = str(config.state_dir() / "server.log")
        # Detached python relaunch (no shell). Paths are passed as argv to the
        # child interpreter, never concatenated into a shell command string.
        try:
            subprocess.Popen(
                [sys.executable, "-c", _RELAUNCH_SRC,
                 str(os.getpid()), sys.executable, script, cwd, log],
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    return 400, {"ok": False, "error": "unknown action"}

#!/usr/bin/env python3
"""Layaider core: low-level process/IO helpers, the safe_path workspace
boundary primitive, the static-file engine, and the routing Handler.

safe_path / sh / read_text / probe_port are defined before the domain modules
are imported so git/session/api can import them without a circular dependency.
The static engine routes every request through safe_path and refuses to serve
source files when falling back to the install root (pre-Phase-3).
"""

import os
import json
import time
import socket
import shutil
import mimetypes
import subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import config

START_TS = int(time.time() * 1000)


class PathValidationError(ValueError):
    """Raised when a requested path escapes its configured workspace root."""


def safe_path(root, rel):
    """Resolve rel against root and confirm the result stays inside root.

    Rejects absolute paths, parent traversal, null bytes, and a leading '-'.
    resolve() canonicalizes symlinks, so a symlink inside root pointing out is
    caught by the final containment test rather than silently followed.
    """
    if rel is None:
        rel = ""
    if not isinstance(rel, str):
        raise PathValidationError("path must be a string")
    if rel.startswith("-"):
        raise PathValidationError("path may not start with '-'")
    if "\x00" in rel:
        raise PathValidationError("path contains a null byte")
    if Path(rel).is_absolute():
        raise PathValidationError("absolute paths are not allowed")
    parts = rel.replace("\\", "/").split("/")
    if any(part == ".." for part in parts):
        raise PathValidationError("path traversal is not allowed")
    try:
        base = Path(root).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PathValidationError("workspace root does not resolve: %s" % exc)
    try:
        target = (base / rel).resolve()
    except (OSError, RuntimeError) as exc:
        raise PathValidationError("path does not resolve: %s" % exc)
    if target != base and base not in target.parents:
        raise PathValidationError("path escapes the workspace root")
    return target


def read_text(path):
    try:
        return Path(path).read_text()
    except Exception:
        return ""


def probe_port(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.8):
            return True
    except OSError:
        return False


def sh(args, cwd=None):
    try:
        out = subprocess.run(
            args, cwd=cwd or config.active_repo(),
            capture_output=True, text=True, timeout=4,
        )
        return out.stdout.rstrip("\r\n") if out.returncode == 0 else None
    except Exception:
        return None


def sh_full(args, cwd=None):
    try:
        out = subprocess.run(args, cwd=cwd or config.active_repo(),
                             capture_output=True, text=True, timeout=8)
        return out.returncode == 0, ((out.stdout or "") + (out.stderr or "")).strip()
    except Exception as e:
        return False, str(e)


def sh_raw(args, cwd=None):
    try:
        out = subprocess.run(args, cwd=cwd or config.active_repo(),
                             capture_output=True, text=True, timeout=8)
        return out.returncode == 0, out.stdout
    except Exception:
        return False, ""


# Domain modules imported after the helpers above are defined (avoids cycles).
import git
import session
import storage
import api
import servers


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, "application/json", json.dumps(obj).encode())

    def _sse_aider_stream(self):
        # Server-Sent Events: tail config.live_log() and push new bytes as they appear. Each event's
        # `id` is the byte offset, so EventSource auto-reconnect resumes via Last-Event-ID
        # with no duplication. Ends (event: end) once the tmux session is gone and the log
        # is drained, so the client can close instead of reconnecting forever.
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
        except Exception:
            return
        try:
            lei = self.headers.get("Last-Event-ID")
            if lei is None:  # fresh EventSource can't set a header; accept ?offset= instead
                lei = parse_qs(urlparse(self.path).query).get("offset", [None])[0]
            offset = int(lei or 0)
        except (TypeError, ValueError):
            offset = 0
        if offset < 0:
            offset = 0
        last_beat = time.time()
        drained_rounds = 0
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    size = config.live_log().stat().st_size
                except OSError:
                    size = 0
                if size < offset:  # log was truncated (a fresh launch) -> restart
                    offset = 0
                data = b""
                if size > offset:
                    with open(config.live_log(), "rb") as f:
                        f.seek(offset)
                        data = f.read()
                    offset += len(data)
                if data:
                    text = session._ansi_strip(data.decode("utf-8", "replace"))
                    fields = "".join("data: %s\n" % ln for ln in text.split("\n"))
                    self.wfile.write(("id: %d\n%s\n" % (offset, fields)).encode("utf-8"))
                    self.wfile.flush()
                    last_beat = time.time()
                    drained_rounds = 0
                    continue  # keep reading while there's a backlog
                # caught up: heartbeat + end-detection
                if not session._tmux_has_session(CONFIG["AIDER_SESSION"]):
                    drained_rounds += 1
                    if drained_rounds >= 2:  # ~1s grace for pipe-pane's trailing flush
                        self.wfile.write(b"event: end\ndata: end\n\n")
                        self.wfile.flush()
                        return
                else:
                    drained_rounds = 0
                if time.time() - last_beat > 15:
                    self.wfile.write(b": beat\n\n")
                    self.wfile.flush()
                    last_beat = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        except Exception:
            return

    def do_GET(self):
        parsed = urlparse(self.path)
        path, q = parsed.path, parse_qs(parsed.query)
        if path == "/api/ping":
            return self._json({"ok": True, "pid": os.getpid(), "boot": START_TS})
        if path == "/api/aider/store":
            try:
                return self._json(storage.aider_store())
            except Exception as e:
                return self._json({"error": str(e)}, 500)
        if path == "/api/aider/effective":
            try:
                eff = storage.blueprint_effective(int(q.get("bp", ["-1"])[0]))
            except (TypeError, ValueError):
                eff = None
            if eff is None:
                return self._json({"error": "bad blueprint"}, 400)
            return self._json(eff)
        if path == "/api/aider/history":
            return self._json(session.read_aider_history())
        if path == "/api/aider/stream":
            return self._sse_aider_stream()
        if path == "/api/status":
            try:
                self._json(api.build_status())
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return
        if path == "/api/repos":
            repos = config.discover_repos()
            for r in repos:
                r["branch"] = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=r["path"])
            act = config.active_repo()
            return self._json({"repos": repos, "active": act, "active_valid": config.is_git_repo(act)})
        if path == "/api/git/changes":
            return self._json(git.git_changes())
        if path == "/api/git/log":
            def gv(k):
                v = q.get(k, [""])[0].strip()
                return v or None
            pth = gv("path")
            if pth and pth.startswith("-"):
                pth = None
            ct = gv("type")
            if ct and not re.match(r"^[a-z]+$", ct):
                ct = None
            try:
                n = max(1, min(100, int(q.get("n", ["30"])[0])))
                skip = max(0, int(q.get("skip", ["0"])[0]))
            except ValueError:
                n, skip = 30, 0
            commits = git.git_log(n=n, skip=skip, grep=gv("grep"), pickaxe=gv("pickaxe"),
                              path=pth, ctype=ct, since=gv("since"), until=gv("until"))
            return self._json({"commits": commits})
        if path == "/api/git/diff":
            f = q.get("file", [""])[0]
            if not git.valid_file(f):
                return self._json({"error": "bad file"}, 400)
            return self._json({"file": f, "diff": git.git_diff(f, q.get("staged", ["0"])[0] == "1")})
        if path == "/api/git/commit":
            h = q.get("hash", [""])[0]
            if not git.HEX.match(h):
                return self._json({"error": "bad hash"}, 400)
            return self._json(git.git_commit_detail(h))
        if path in ("/api/git/filediff", "/api/git/filemeta", "/api/git/show"):
            h = q.get("hash", [""])[0]
            f = q.get("file", [""])[0]
            if not git.HEX.match(h):
                return self._json({"error": "bad hash"}, 400)
            if not git.valid_file(f):
                return self._json({"error": "bad file"}, 400)
            if path == "/api/git/filediff":
                return self._json({"file": f, "diff": git.git_file_diff(h, f)})
            if path == "/api/git/show":
                return self._json(git.git_show_file(h, f))
            return self._json(git.git_file_meta(h, f))
        if path == "/api/sync/status":
            return self._json(git.git_sync_status())
        if path == "/api/sync/branches":
            return self._json(git.git_branches())
        if path == "/api/sync/incoming":
            return self._json({"commits": git.git_range_commits("HEAD..@{u}")})
        if path == "/api/sync/outgoing":
            return self._json({"commits": git.git_range_commits("@{u}..HEAD")})
        if path == "/api/files/list":
            return self._json(git.files_list(q.get("path", [""])[0], q.get("show", ["0"])[0] == "1"))
        if path == "/api/servers":
            return self._json(servers.snapshot())
        if path == "/api/system":
            return self._json(api.system_info())
        if path == "/api/system/procs":
            return self._json({"procs": api.system_procs()})
        if path == "/api/files/grep":
            return self._json(git.files_grep(q.get("q", [""])[0].strip()))
        if path == "/api/files/raw":
            f = q.get("path", [""])[0]
            if not git.valid_file(f):
                return self._send(400, "text/plain", b"bad path")
            rp = git.safe_fs(f)
            if rp is None or not rp.is_file():
                return self._send(404, "text/plain", b"not found")
            try:
                data = rp.read_bytes()[:10000000]
            except Exception:
                return self._send(500, "text/plain", b"read error")
            ctype = mimetypes.guess_type(str(rp))[0] or "application/octet-stream"
            return self._send(200, ctype, data)
        if path in ("/api/files/read", "/api/files/meta", "/api/files/diff"):
            f = q.get("path", [""])[0]
            if not git.valid_file(f):
                return self._json({"error": "bad path"}, 400)
            if path == "/api/files/read":
                return self._json(git.files_read(f))
            if path == "/api/files/meta":
                return self._json(git.files_meta(f))
            return self._json({"file": f, "diff": git.files_diff(f)})
        if path == "/api/docs":
            name = q.get("path", [""])[0]
            if not name:
                return self._json({"docs": api.list_docs()})
            txt = api.read_doc(name)
            if txt is None:
                return self._json({"error": "not found"}, 404)
            return self._json({"path": name, "text": txt})
        self._serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        if path == "/api/repo":
            ok = config.set_active(body.get("path"))
            return self._json({"ok": ok, "active": config.active_repo()}, 200 if ok else 400)
        if path == "/api/repo/init":
            p = body.get("path")
            if not p or not isinstance(p, str):
                return self._json({"ok": False, "error": "bad path"}, 400)
            rp = str(Path(p).expanduser())
            if not config.is_git_repo(rp):
                try:
                    os.makedirs(rp, exist_ok=True)
                except Exception as e:
                    return self._json({"ok": False, "error": str(e)}, 400)
                sh(["git", "init"], cwd=rp)
            if config.is_git_repo(rp):
                config.set_active(rp)
                return self._json({"ok": True, "active": config.active_repo()})
            return self._json({"ok": False, "error": "init failed"}, 400)
        if path == "/api/repo/forget":
            p = body.get("path")
            if not p or not isinstance(p, str):
                return self._json({"ok": False, "error": "bad path"}, 400)
            config.forget_repo(p)
            return self._json({"ok": True, "active": config.active_repo()})
        if path == "/api/repo/deinit":
            # Remove the .git folder (de-init), keeping the files. Only for repos
            # Layaider already manages, so it can't be aimed at arbitrary paths.
            p = body.get("path")
            rp = str(Path(p).expanduser()) if isinstance(p, str) and p else ""
            if not rp or not config.is_git_repo(rp):
                return self._json({"ok": False, "error": "not a git repo"}, 400)
            if rp not in {r["path"] for r in config.discover_repos()}:
                return self._json({"ok": False, "error": "unknown repo"}, 400)
            try:
                shutil.rmtree(os.path.join(rp, ".git"))
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 200)
            config.forget_repo(rp)
            return self._json({"ok": True, "active": config.active_repo()})
        if path.startswith("/api/servers/"):
            action = path[len("/api/servers/"):]
            try:
                code, payload = servers.do_servers(action, body)
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        if path.startswith("/api/system/"):
            action = path[len("/api/system/"):]
            try:
                code, payload = api.do_system(action, body)
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        if path.startswith("/api/files/"):
            action = path[len("/api/files/"):]
            try:
                code, payload = git.do_files(action, body)
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        if path.startswith("/api/sync/"):
            action = path[len("/api/sync/"):]
            try:
                code, payload = git.do_sync(action, body)
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        # Live controls — must work WHILE aider runs, so they bypass the config lock below.
        _live_ctrl = {
            "/api/aider/input": session.do_aider_input,
            "/api/aider/interrupt": session.do_aider_interrupt,
            "/api/aider/exit": session.do_aider_exit,
            "/api/aider/terminate": session.do_aider_terminate,
            "/api/aider/kill": session.do_aider_kill,
        }
        if path in _live_ctrl:
            try:
                code, payload = _live_ctrl[path](body)
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        if path.startswith("/api/aider/"):
            if session.aider_status()["active"]:
                return self._json({"ok": False, "error": "locked", "reason": "aider is running"}, 423)
            try:
                if path == "/api/aider/keys":
                    code, payload = storage.do_aider_keys(body)
                elif path == "/api/aider/blueprint":
                    code, payload = storage.do_aider_blueprint(body)
                elif path == "/api/aider/options":
                    code, payload = storage.do_aider_options(body)
                elif path == "/api/aider/launch":
                    code, payload = session.do_aider_launch(body)
                elif path.startswith("/api/aider/list/"):
                    code, payload = storage.do_aider_list(path[len("/api/aider/list/"):], body)
                else:
                    code, payload = 404, {"ok": False, "error": "not found"}
            except Exception as e:
                code, payload = 500, {"ok": False, "error": str(e)}
            return self._json(payload, code)
        if not path.startswith("/api/git/"):
            return self._send(404, "text/plain", b"not found")
        action = path[len("/api/git/"):]
        try:
            code, payload = git.do_write(action, body)
        except Exception as e:
            code, payload = 500, {"ok": False, "error": str(e)}
        self._json(payload, code)

    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        try:
            target = safe_path(config.public_dir(), rel)
        except PathValidationError:
            return self._send(404, "text/plain", b"not found")
        if not target.is_file():
            return self._send(404, "text/plain", b"not found")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, ctype, target.read_bytes())


def run_server(cfg=None):
    if cfg is not None:
        config.set_config(cfg)
    host, port = config.server_host(), config.server_port()
    srv = ThreadingHTTPServer((host, port), Handler)
    print("Layaider: http://%s:%d   repo: %s" % (host, port, config.active_repo()))
    try:
        started = servers.boot()   # start autostart-enabled managed servers
        if started:
            print("Layaider: autostarted %d server(s)" % len(started))
    except Exception as e:
        print("Layaider: server autostart skipped (%s)" % e)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()

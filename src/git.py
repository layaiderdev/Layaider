#!/usr/bin/env python3
"""Layaider git abstraction layer and working-tree browser. Every process
call uses a subprocess argv array with shell=False. Filesystem access is
confined to the active repo through core.safe_path; git pathspec arguments
are validated by valid_file (argv-isolated, repo-confined by git itself).
"""

import os
import re
import json
import shutil
import subprocess
from pathlib import Path

import config
import session
from core import safe_path, PathValidationError, sh, sh_full, sh_raw


def safe_fs(rel):
    """Resolve a repo-relative path or return None (preserves the legacy
    None-checking call sites while enforcing core.safe_path)."""
    try:
        return safe_path(_files_root(), rel)
    except PathValidationError:
        return None


HEX = re.compile(r"^[0-9a-fA-F]{4,40}$")

TAGRE = re.compile(r"^[\w][\w./-]{0,60}$")

BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


def valid_file(f):
    return isinstance(f, str) and f and not f.startswith("-") and ".." not in f.split("/")


# Files that must never be committed. Two scopes:
#   - UNIVERSAL: credential-bearing by convention; refused in *any* repo. The
#     ".env.example" / ".env.sample" style files have different basenames and
#     are intentionally not matched.
#   - SELF-REPO: Layaider's own config/secrets/sentinel. These names are generic
#     elsewhere (a user's project may legitimately track its own config.json),
#     so they are only refused when the active repo *is* the Layaider install.
NEVER_COMMIT_UNIVERSAL = {".env", "keys.list"}
NEVER_COMMIT_SELF = {"config.json", "project_hooks.py", "DEV"}


def _is_self_repo():
    try:
        return str(_files_root()) == str(Path(config.install_path()).resolve())
    except Exception:
        return False


def _commit_block_reason(rel):
    """Return a human reason if ``rel`` must never be committed, else None."""
    base = rel.rsplit("/", 1)[-1]
    if base in NEVER_COMMIT_UNIVERSAL:
        return base + " holds credentials and must never be committed"
    if base in NEVER_COMMIT_SELF and _is_self_repo():
        return base + " is a Layaider config/secret file and is gitignored in this repo"
    return None


def _protected_in(relpaths):
    """Filter ``relpaths`` to the subset that must never be committed."""
    out = []
    for r in relpaths:
        reason = _commit_block_reason(r)
        if reason:
            out.append({"file": r, "reason": reason})
    return out


def _branch():
    b = sh(["git", "symbolic-ref", "--short", "HEAD"])
    if b:
        return b
    return sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]) or "HEAD"


def git_status():
    if sh(["git", "rev-parse", "--is-inside-work-tree"]) != "true":
        return {"repo": False}
    branch = _branch()
    last = sh(["git", "log", "-1", "--format=%h%x1f%s"])
    porcelain = sh(["git", "status", "--porcelain"])
    staged = modified = untracked = 0
    if porcelain:
        for line in porcelain.splitlines():
            if not line:
                continue
            if line.startswith("??"):
                untracked += 1
                continue
            x, y = line[0], line[1]
            if x not in (" ", "?"):
                staged += 1
            if y not in (" ", "?"):
                modified += 1
    ahead = behind = None
    ab = sh(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    if ab:
        parts = ab.split()
        if len(parts) == 2:
            behind, ahead = int(parts[0]), int(parts[1])
    h, _, subj = (last or "").partition("\x1f")
    return {
        "repo": True, "branch": branch,
        "staged": staged, "modified": modified, "untracked": untracked,
        "ahead": ahead, "behind": behind, "last": {"hash": h, "subject": subj},
    }


def stub_scan():
    listing = sh(["git", "ls-files"])
    if not listing:
        return []
    flagged = []
    for rel in listing.splitlines():
        if not rel.endswith(config.stub_exts()):
            continue
        try:
            txt = (Path(config.active_repo()) / rel).read_text(errors="ignore")
            lines = sum(1 for l in txt.splitlines() if l.strip())
            if lines <= config.stub_max_lines():
                flagged.append({"file": rel, "lines": lines})
        except Exception:
            pass
    return flagged


def _numstat(extra):
    out = sh(["git", "diff", "--numstat"] + extra)
    rows = []
    if out:
        for ln in out.splitlines():
            p = ln.split("\t")
            if len(p) >= 3:
                rows.append({
                    "file": p[2],
                    "add": None if p[0] == "-" else int(p[0]),
                    "del": None if p[1] == "-" else int(p[1]),
                })
    return rows


def git_changes():
    if sh(["git", "rev-parse", "--is-inside-work-tree"]) != "true":
        return {"repo": False}
    branch = _branch()
    untracked = [f for f in (sh(["git", "ls-files", "--others", "--exclude-standard"]) or "").splitlines() if f]
    ahead = behind = None
    ab = sh(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    if ab:
        parts = ab.split()
        if len(parts) == 2:
            behind, ahead = int(parts[0]), int(parts[1])
    return {
        "repo": True, "branch": branch,
        "staged": _numstat(["--cached"]),
        "modified": _numstat([]),
        "untracked": untracked,
        "ahead": ahead, "behind": behind,
    }


def git_diff(file, staged):
    args = ["git", "diff"] + (["--cached"] if staged else []) + ["--", file]
    return sh(args) or ""


def git_log(n=30, skip=0, grep=None, pickaxe=None, path=None, ctype=None, since=None, until=None):
    args = ["git", "log", "--no-color", "--shortstat",
            "--format=%h%x1f%s%x1f%cr%x1f%cs%x1f%an%x1f%D",
            "-n", str(n), "--skip", str(skip)]
    greps = []
    if ctype:
        greps.append("^" + ctype)
    if grep:
        greps.append(grep)
    for gp in greps:
        args.append("--grep=" + gp)
    if greps:
        args.append("--regexp-ignore-case")
        if len(greps) > 1:
            args.append("--all-match")
    if pickaxe:
        args.append("-S" + pickaxe)
    if since:
        args.append("--since=" + since)
    if until:
        args.append("--until=" + until)
    if path:
        args += ["--", path]
    out = sh(args)
    commits = []
    cur = None
    if out:
        for ln in out.splitlines():
            if "\x1f" in ln:
                p = ln.split("\x1f")
                if len(p) >= 6:
                    tags = [r.strip()[5:] for r in p[5].split(",") if r.strip().startswith("tag: ")]
                    cur = {"hash": p[0], "subject": p[1], "rel": p[2],
                           "date": p[3], "author": p[4], "tags": tags,
                           "files": 0, "additions": 0, "deletions": 0}
                    commits.append(cur)
            elif cur is not None and "changed" in ln:
                m = re.search(r"(\d+) files? changed", ln)
                if m:
                    cur["files"] = int(m.group(1))
                m = re.search(r"(\d+) insertions?\(\+\)", ln)
                if m:
                    cur["additions"] = int(m.group(1))
                m = re.search(r"(\d+) deletions?\(-\)", ln)
                if m:
                    cur["deletions"] = int(m.group(1))
    return commits


def _parse_numstat(out):
    d = {}
    if out:
        for ln in out.splitlines():
            if not ln.strip():
                continue
            p = ln.split("\t")
            if len(p) >= 3:
                key = p[2]
                if " => " in key:
                    key = key.split(" => ")[-1].strip("}").strip()
                d[key] = (p[0], p[1])
    return d


def git_commit_detail(h):
    meta = sh(["git", "show", "-s", "--date=format:%Y-%m-%d %H:%M",
               "--format=%h%x1f%an%x1f%ad%x1f%ar%x1f%P%x1f%D%x1f%s", h]) or ""
    parts = meta.split("\x1f")
    while len(parts) < 7:
        parts.append("")
    short, author, adate, rel, parents, refs, subject = parts[:7]
    body = (sh(["git", "show", "-s", "--format=%b", h]) or "").strip()
    tags = [r.strip()[5:] for r in refs.split(",") if r.strip().startswith("tag: ")]
    nstat = _parse_numstat(sh(["git", "show", "--numstat", "--format=", "-1", h]))
    ns = sh(["git", "show", "--name-status", "--format=", "-1", h])
    files = []
    tot_add = tot_del = 0
    if ns:
        for ln in ns.splitlines():
            if not ln.strip():
                continue
            p = ln.split("\t")
            status = p[0]
            newpath = p[-1]
            oldpath = p[1] if (status[:1] in ("R", "C")) and len(p) >= 3 else None
            add, dele = nstat.get(newpath, ("", ""))
            ai = int(add) if add.isdigit() else 0
            di = int(dele) if dele.isdigit() else 0
            tot_add += ai
            tot_del += di
            files.append({
                "status": status, "file": newpath, "old": oldpath,
                "additions": ai if add.isdigit() else None,
                "deletions": di if dele.isdigit() else None,
                "binary": (add == "-" and dele == "-"),
            })
    return {
        "hash": h, "short": short, "subject": subject, "body": body,
        "author": author, "date": adate, "rel": rel,
        "parents": parents.split() if parents else [], "tags": tags,
        "files": files,
        "stat": {"files": len(files), "additions": tot_add, "deletions": tot_del},
    }


def git_file_diff(h, f):
    return sh(["git", "show", "--format=", "-1", h, "--", f]) or ""


def git_file_meta(h, f):
    mode = blob = None
    lst = sh(["git", "ls-tree", h, "--", f])
    if lst:
        head = lst.split("\t")[0].split()
        if len(head) >= 3:
            mode, _, blob = head[0], head[1], head[2]
    size = sh(["git", "cat-file", "-s", h + ":" + f])
    content = sh(["git", "show", h + ":" + f])
    lines = (content.count("\n") + 1) if content else None
    binary = bool(content) and ("\x00" in content)
    return {
        "file": f, "mode": mode, "blob": blob,
        "size": int(size) if size and size.isdigit() else None,
        "lines": lines, "binary": binary,
    }


def git_show_file(h, f, cap=600000):
    ok, out = sh_raw(["git", "show", h + ":" + f])
    if not ok:
        return {"file": f, "error": "this file does not exist at this commit"}
    binary = "\x00" in out
    truncated = len(out) > cap
    if truncated:
        out = out[:cap]
    return {
        "file": f, "binary": binary, "truncated": truncated,
        "content": "" if binary else out,
        "lines": (out.count("\n") + 1) if (out and not binary) else 0,
    }


def valid_branch(b):
    return isinstance(b, str) and b and not b.startswith("-") and ".." not in b and BRANCH_RE.match(b)


def _upstream():
    return sh(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])


def _git_net_env():
    # Never block on a credential prompt; make SSH non-interactive and time-bounded.
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
    return env


def _run_net(args, timeout=30):
    """Run a network git command non-interactively. Returns (ok, combined_output)."""
    try:
        p = subprocess.run(args, cwd=config.active_repo(), shell=False,
                           capture_output=True, text=True, timeout=timeout, env=_git_net_env())
        return p.returncode == 0, ((p.stdout or "") + (p.stderr or "")).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)


def _classify_git_error(text):
    low = (text or "").lower()
    if "could not resolve" in low or "could not connect" in low or "timed out" in low or "timeout" in low:
        return "network"
    if ("authentication failed" in low or "could not read username" in low
            or "invalid username or password" in low or "terminal prompts disabled" in low or "403" in low):
        return "auth"
    if "permission denied" in low or "publickey" in low:
        return "sshkey"
    if "host key verification failed" in low:
        return "hostkey"
    if "repository not found" in low or "not found" in low or "does not exist" in low or "404" in low:
        return "notfound"
    return "error"


# --- auth/identity library -------------------------------------------------
# Multiple saved logins/identities, each scoped to the repos it's for. Stored
# 0600 on-device (local-first); tokens are kept in cleartext under the user's
# own file permissions, masked in the UI with an explicit unmask.
def _auth_path():
    return Path(config.state_dir()) / "git_auth.json"


def read_auths():
    p = _auth_path()
    try:
        if p.is_file():
            data = json.loads(p.read_text())
            if isinstance(data, dict) and isinstance(data.get("auths"), list):
                return data["auths"]
    except (OSError, ValueError):
        pass
    return []


def write_auths(auths):
    p = _auth_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    tmp = str(p) + ".tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps({"auths": auths}, indent=2))
    os.replace(tmp, str(p))
    try:
        os.chmod(str(p), 0o600)
    except OSError:
        pass


def git_sync_status():
    if sh(["git", "rev-parse", "--is-inside-work-tree"]) != "true":
        return {"repo": False}
    branch = _branch()
    has_commits = bool(sh(["git", "rev-parse", "--verify", "--quiet", "HEAD"]))
    remotes = (sh(["git", "remote"]) or "").split()
    remote = "origin" if "origin" in remotes else (remotes[0] if remotes else None)
    url = sh(["git", "remote", "get-url", remote]) if remote else None
    upstream = _upstream()
    ahead = behind = None
    unrelated = False
    if upstream:
        lr = sh(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"])
        if lr:
            parts = lr.split()
            if len(parts) == 2:
                behind, ahead = int(parts[0]), int(parts[1])
        # no shared ancestor => unrelated histories (fresh local meeting non-empty remote)
        if not sh(["git", "merge-base", "HEAD", "@{u}"]):
            unrelated = True
    last_fetch = None
    fh = Path(config.active_repo()) / ".git" / "FETCH_HEAD"
    if fh.is_file():
        last_fetch = int(fh.stat().st_mtime)
    name = sh(["git", "config", "user.name"])
    email = sh(["git", "config", "user.email"])
    ghuser = ""
    try:
        ghuser = (config.get_config().get("identity") or {}).get("github_user") or ""
    except Exception:
        ghuser = ""
    tools = {
        "ssh": bool(shutil.which("ssh")),
        "sshKeygen": bool(shutil.which("ssh-keygen")),
        "gh": bool(shutil.which("gh")),
    }
    if not remote:
        state = "no remote"
    elif not has_commits:
        state = "empty"
    elif not upstream:
        state = "no upstream"
    elif ahead and behind:
        state = "diverged"
    elif ahead:
        state = "ahead"
    elif behind:
        state = "behind"
    else:
        state = "up to date"
    return {
        "repo": True, "branch": branch, "remote": remote, "url": url,
        "upstream": upstream, "ahead": ahead, "behind": behind,
        "lastFetch": last_fetch, "state": state, "unrelated": unrelated,
        "hasCommits": has_commits,
        "name": name or "", "email": email or "", "tools": tools, "ghuser": ghuser,
    }


def git_range_commits(rng):
    out = sh(["git", "log", "--no-color", "--shortstat",
              "--format=%h%x1f%s%x1f%cr%x1f%cs%x1f%an%x1f%D", rng])
    commits = []
    cur = None
    if out:
        for ln in out.splitlines():
            if "\x1f" in ln:
                p = ln.split("\x1f")
                if len(p) >= 6:
                    tags = [r.strip()[5:] for r in p[5].split(",") if r.strip().startswith("tag: ")]
                    cur = {"hash": p[0], "subject": p[1], "rel": p[2], "date": p[3],
                           "author": p[4], "tags": tags, "files": 0, "additions": 0, "deletions": 0}
                    commits.append(cur)
            elif cur is not None and "changed" in ln:
                m = re.search(r"(\d+) files? changed", ln)
                if m:
                    cur["files"] = int(m.group(1))
                m = re.search(r"(\d+) insertions?\(\+\)", ln)
                if m:
                    cur["additions"] = int(m.group(1))
                m = re.search(r"(\d+) deletions?\(-\)", ln)
                if m:
                    cur["deletions"] = int(m.group(1))
    return commits


def git_branches():
    cur = _branch()
    local = []
    for ln in (sh(["git", "branch", "--format=%(refname:short)"]) or "").splitlines():
        ln = ln.strip()
        if ln:
            local.append(ln)
    remote = []
    for ln in (sh(["git", "branch", "-r", "--format=%(refname:short)"]) or "").splitlines():
        ln = ln.strip()
        if ln and "->" not in ln:
            remote.append(ln)
    return {"current": cur, "local": local, "remote": remote}


def dedup_tag(name):
    existing = set((sh(["git", "tag", "--list"]) or "").splitlines())
    if name not in existing:
        return name
    i = 2
    while (name + "-" + str(i)) in existing:
        i += 1
    return name + "-" + str(i)


def _files_root():
    return Path(config.active_repo()).resolve()


def _work_status_map():
    m = {}
    out = sh(["git", "status", "--porcelain"])
    if out:
        for ln in out.splitlines():
            if len(ln) < 4:
                continue
            x, y, pth = ln[0], ln[1], ln[3:]
            if " -> " in pth:
                pth = pth.split(" -> ")[-1]
            if x == "?":
                m[pth] = "untracked"
            elif x != " ":
                m[pth] = "staged" if y == " " else "staged+modified"
            elif y != " ":
                m[pth] = "modified"
    return m


def _is_stub(p):
    if p.suffix.lower() not in (".js", ".mjs"):
        return False
    try:
        txt = p.read_text(errors="replace")
    except Exception:
        return False
    nonblank = [l for l in txt.splitlines() if l.strip()]
    return len(nonblank) <= 2


def files_list(rel, show):
    base = safe_fs(rel)
    root = _files_root()
    if base is None or not base.is_dir():
        return {"error": "bad path"}
    status = _work_status_map()
    entries = []
    try:
        for ch in base.iterdir():
            name = ch.name
            if not show and (name.startswith(".") or name == "node_modules"):
                continue
            is_dir = ch.is_dir()
            relpath = str(ch.relative_to(root))
            ent = {"name": name, "path": relpath, "dir": is_dir}
            if not is_dir:
                try:
                    st = ch.stat()
                    ent["size"] = st.st_size
                    ent["mtime"] = int(st.st_mtime)
                except Exception:
                    ent["size"] = ent["mtime"] = None
                ent["status"] = status.get(relpath)
                ent["stub"] = _is_stub(ch)
            entries.append(ent)
    except Exception as e:
        return {"error": str(e)}
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    igmap = _ignored_map([e["path"] for e in entries])
    for e in entries:
        if e["path"] in igmap:
            e["ignored"] = True
            e["ignoredDefault"] = not igmap[e["path"]]
    return {"path": rel or "", "root": str(root), "entries": entries}


def files_read(rel, cap=600000):
    p = safe_fs(rel)
    if p is None or not p.is_file():
        return {"error": "not found"}
    try:
        data = p.read_bytes()
    except Exception as e:
        return {"error": str(e)}
    binary = b"\x00" in data[:8000]
    truncated = len(data) > cap
    if truncated:
        data = data[:cap]
    text = "" if binary else data.decode("utf-8", errors="replace")
    return {"file": rel, "binary": binary, "truncated": truncated, "content": text,
            "lines": (text.count("\n") + 1) if (text and not binary) else 0}


def files_meta(rel):
    p = safe_fs(rel)
    if p is None or not p.exists():
        return {"error": "not found"}
    st = p.stat()
    data = b""
    try:
        data = p.read_bytes()
    except Exception:
        pass
    binary = b"\x00" in data[:8000]
    text = "" if binary else data.decode("utf-8", errors="replace")
    ig = files_ignore(rel)
    tracked = sh(["git", "ls-files", "--error-unmatch", "--", rel]) is not None
    return {"file": rel, "size": st.st_size, "mtime": int(st.st_mtime),
            "mode": oct(st.st_mode & 0o777), "exec": bool(st.st_mode & 0o111),
            "binary": binary, "status": _work_status_map().get(rel),
            "tracked": tracked,
            "ignored": ig["ignored"], "ignoredRepoLevel": ig["repo_level"], "ignoreSource": ig["source"],
            "lines": (text.count("\n") + 1) if (text and not binary) else None}


def files_diff(rel):
    return sh(["git", "diff", "HEAD", "--", rel]) or ""


def files_grep(q, cap=400):
    if not q:
        return {"matches": []}
    _, out = sh_raw(["git", "grep", "-F", "-n", "-I", "-i", "--untracked", "-e", q])
    groups, order, n = {}, [], 0
    for ln in (out or "").splitlines():
        parts = ln.split(":", 2)
        if len(parts) < 3 or not parts[1].isdigit():
            continue
        f = parts[0]
        if f not in groups:
            groups[f] = []
            order.append(f)
        groups[f].append({"line": int(parts[1]), "text": parts[2][:200]})
        n += 1
        if n >= cap:
            break
    return {"matches": [{"file": f, "hits": groups[f]} for f in order], "truncated": n >= cap}


def files_ignore(rel):
    ok, out = sh_full(["git", "check-ignore", "-v", "--", rel])
    if not ok or not out:
        return {"ignored": False, "repo_level": False, "source": None}
    src = out.splitlines()[0].split("\t")[0]
    source = src.split(":")[0]
    repo_level = source.endswith(".gitignore") and not os.path.isabs(source)
    return {"ignored": True, "repo_level": repo_level, "source": source}


def _ignored_map(relpaths):
    """Returns {path: repo_level_bool} for the ignored subset of relpaths."""
    if not relpaths:
        return {}
    ok, out = sh_full(["git", "check-ignore", "-v", "--"] + relpaths)
    m = {}
    if out:
        for line in out.splitlines():
            if "\t" not in line:
                continue
            src, pth = line.split("\t", 1)
            source = src.split(":")[0]
            m[pth] = source.endswith(".gitignore") and not os.path.isabs(source)
    return m


def do_files(action, body):
    if sh(["git", "rev-parse", "--is-inside-work-tree"]) != "true":
        return 400, {"ok": False, "error": "no repo"}
    if session.aider_status()["active"]:
        return 423, {"ok": False, "error": "locked", "reason": "aider is running"}
    rel = body.get("path")
    if not valid_file(rel) or safe_fs(rel) is None:
        return 400, {"ok": False, "error": "bad path"}
    p = safe_fs(rel)
    if action == "rename":
        to = body.get("to")
        if not valid_file(to) or safe_fs(to) is None:
            return 400, {"ok": False, "error": "bad target"}
        tp = safe_fs(to)
        try:
            os.makedirs(tp.parent, exist_ok=True)
        except Exception:
            pass
        ok, out = sh_full(["git", "mv", "--", rel, to])
        if not ok:
            try:
                os.rename(p, tp)
                ok, out = True, "renamed"
            except Exception as e:
                return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": ok, "output": out, "to": to}
    if action == "chmod":
        ex = bool(body.get("exec"))
        try:
            cur = p.stat().st_mode
            os.chmod(p, (cur | 0o111) if ex else (cur & ~0o111))
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        sh(["git", "update-index", "--chmod=" + ("+x" if ex else "-x"), "--", rel])
        return 200, {"ok": True, "exec": ex}
    if action == "new":
        if p.exists():
            return 200, {"ok": False, "output": "already exists"}
        try:
            os.makedirs(p.parent, exist_ok=True)
            p.write_text("")
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action == "mkdir":
        try:
            os.makedirs(p, exist_ok=True)
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action == "delete":
        tracked = sh(["git", "ls-files", "--error-unmatch", "--", rel]) is not None
        if tracked:
            ok, out = sh_full(["git", "rm", "-r", "-f", "--", rel])
            return 200, {"ok": ok, "output": out}
        try:
            if p.is_dir():
                shutil.rmtree(p)
            else:
                os.remove(p)
        except Exception as e:
            return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action == "ignore-add":
        gi = _files_root() / ".gitignore"
        lines = gi.read_text().splitlines() if gi.exists() else []
        entry = "/" + rel
        if entry not in lines and rel not in lines:
            lines.append(entry)
            try:
                gi.write_text("\n".join(lines) + "\n")
            except Exception as e:
                return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action == "ignore-remove":
        gi = _files_root() / ".gitignore"
        if gi.exists():
            lines = gi.read_text().splitlines()
            keep = [l for l in lines if l.strip() not in (rel, "/" + rel)]
            try:
                gi.write_text("\n".join(keep) + ("\n" if keep else ""))
            except Exception as e:
                return 200, {"ok": False, "output": str(e)}
        return 200, {"ok": True}
    if action == "force-add":
        ok, out = sh_full(["git", "add", "-f", "--", rel])
        return 200, {"ok": ok, "output": out}
    if action == "untrack":
        # Stop tracking the file (git rm --cached) while keeping it on disk. The
        # file stays in history and on any remote — only future commits drop it.
        tracked = sh(["git", "ls-files", "--error-unmatch", "--", rel]) is not None
        if not tracked:
            return 200, {"ok": True, "output": "not tracked", "tracked": False}
        ok, out = sh_full(["git", "rm", "--cached", "--", rel])
        return 200, {"ok": ok, "output": out, "tracked": True}
    return 400, {"ok": False, "error": "unknown action"}


def do_sync(action, body):
    if sh(["git", "rev-parse", "--is-inside-work-tree"]) != "true":
        return 400, {"ok": False, "error": "no repo"}

    # fetch is safe (no working-tree change) and stays available even while aider runs
    if action == "fetch":
        ok, out = sh_full(["git", "fetch", "--prune"])
        return 200, {"ok": ok, "output": out}

    # test validates a connection without changing anything (read-only).
    if action == "test":
        url = (body.get("url") or "").strip()
        ok, out = _run_net(["git", "ls-remote", "--heads", url or "origin"], timeout=25)
        if ok:
            heads = len([ln for ln in out.splitlines() if ln.strip()])
            return 200, {"ok": True, "kind": "ok", "heads": heads, "message": "connection OK"}
        return 200, {"ok": False, "kind": _classify_git_error(out), "message": out[:600]}

    # connect = set remote (if a url is given) -> fetch -> link upstream when a
    # matching remote branch exists. This is what makes status populate; saving
    # a remote alone never sets up tracking.
    if action == "connect":
        url = (body.get("url") or "").strip()
        name = (body.get("name") or "origin").strip()
        if not re.match(r"^[A-Za-z0-9._-]{1,40}$", name):
            return 400, {"ok": False, "error": "bad remote name"}
        if url:
            remotes = (sh(["git", "remote"]) or "").split()
            if name in remotes:
                sh_full(["git", "remote", "set-url", name, url])
            else:
                sh_full(["git", "remote", "add", name, url])
        ok_f, out_f = _run_net(["git", "fetch", "--prune", name], timeout=40)
        if not ok_f:
            return 200, {"ok": False, "stage": "fetch", "kind": _classify_git_error(out_f),
                         "message": out_f[:600]}
        branch = _branch()
        rb = name + "/" + branch
        # does the remote have a branch matching our current local branch?
        has_rb = bool(sh(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/" + rb]))
        if has_rb:
            ok_u, out_u = sh_full(["git", "branch", "--set-upstream-to=" + rb])
            return 200, {"ok": ok_u, "stage": "linked", "upstream": rb, "message": out_u}
        return 200, {"ok": True, "stage": "nobranch",
                     "message": "fetched OK, but the remote has no '" + branch
                                + "' branch yet — push to publish it and set tracking"}

    # explicit write-permission probe on the configured remote; transfers nothing.
    if action == "test-write":
        name = (body.get("name") or "origin").strip()
        if not re.match(r"^[A-Za-z0-9._-]{1,40}$", name):
            return 400, {"ok": False, "error": "bad remote name"}
        branch = _branch()
        ok, out = _run_net(["git", "push", "--dry-run", name, branch + ":" + branch], timeout=30)
        if ok:
            return 200, {"ok": True, "kind": "ok", "message": "push access confirmed (dry run)"}
        return 200, {"ok": False, "kind": _classify_git_error(out), "message": out[:600]}

    if action == "ssh-pubkey":
        pub = os.path.expanduser("~/.ssh/id_ed25519.pub")
        if os.path.isfile(pub):
            try:
                return 200, {"ok": True, "pubkey": open(pub).read().strip(), "path": pub}
            except OSError:
                pass
        return 200, {"ok": False, "pubkey": "", "path": pub}

    if action == "auth-list":
        return 200, {"ok": True, "auths": read_auths()}

    if action == "auth-save":
        auths = read_auths()
        label = (body.get("label") or "").strip()[:60]
        if not label:
            return 400, {"ok": False, "error": "label required"}
        scopes = body.get("scopes") or []
        if not isinstance(scopes, list):
            scopes = []
        scopes = [str(x).strip()[:200] for x in scopes if str(x).strip()][:50]
        fields = {
            "label": label,
            "method": (body.get("method") or "https").strip()[:12],
            "host": (body.get("host") or "github.com").strip()[:120],
            "username": (body.get("username") or "").strip()[:120],
            "name": (body.get("name") or "").strip()[:120],
            "email": (body.get("email") or "").strip()[:160],
            "scopes": scopes,
        }
        token = body.get("token") or ""
        aid = body.get("id")
        existing = next((a for a in auths if a.get("id") == aid), None) if aid is not None else None
        if existing:
            existing.update(fields)
            if token:  # an empty token on edit keeps the stored one
                existing["token"] = token
        else:
            aid = (max([a.get("id", 0) for a in auths] or [0]) + 1)
            fields["id"] = aid
            fields["token"] = token
            auths.append(fields)
        write_auths(auths)
        return 200, {"ok": True, "id": aid, "auths": auths}

    if action == "auth-delete":
        aid = body.get("id")
        write_auths([a for a in read_auths() if a.get("id") != aid])
        return 200, {"ok": True, "auths": read_auths()}

    if action == "ssh-keygen":
        home = os.path.expanduser("~")
        sshdir = os.path.join(home, ".ssh")
        key = os.path.join(sshdir, "id_ed25519")
        pub = key + ".pub"
        try:
            os.makedirs(sshdir, exist_ok=True)
            os.chmod(sshdir, 0o700)
        except OSError:
            pass
        if not os.path.isfile(key):
            comment = (body.get("comment") or "layaider").strip()[:120] or "layaider"
            ok, out = sh_full(["ssh-keygen", "-t", "ed25519", "-q", "-N", "", "-f", key, "-C", comment])
            if not os.path.isfile(pub):
                return 200, {"ok": False, "output": out or "ssh-keygen failed"}
        try:
            return 200, {"ok": True, "pubkey": open(pub).read().strip(), "path": pub}
        except OSError as e:
            return 200, {"ok": False, "output": str(e)}

    if session.aider_status()["active"]:
        return 423, {"ok": False, "error": "locked", "reason": "aider is running"}

    if action == "pull":
        mode = body.get("mode", "ff")
        if body.get("dry"):
            # pull has no real --dry-run; fetch and report what WOULD integrate.
            ok, out = _run_net(["git", "fetch", "--prune"], timeout=40)
            if not ok:
                return 200, {"ok": False, "dry": True, "kind": _classify_git_error(out), "output": out[:600]}
            n = 0
            lr = sh(["git", "rev-list", "--count", "HEAD..@{u}"])
            if lr and lr.isdigit():
                n = int(lr)
            return 200, {"ok": True, "dry": True,
                         "output": "dry run: fetched. " + str(n) + " commit(s) would be integrated by a "
                                   + ("rebase" if mode == "rebase" else "fast-forward") + " pull. Turn off dry run to apply."}
        args = ["git", "pull", "--rebase"] if mode == "rebase" else ["git", "pull", "--ff-only"]
        ok, out = sh_full(args)
        return 200, {"ok": ok, "output": out}

    if action == "populate":
        # Fill an empty (or to-be-overwritten) local branch from the remote — the
        # "pull a GitHub into an empty git" path. checkout -B resets the branch to
        # the remote, so the UI only offers this when the local has no commits.
        name = (body.get("name") or "origin").strip()
        if not re.match(r"^[A-Za-z0-9._-]{1,40}$", name):
            return 400, {"ok": False, "error": "bad remote name"}
        ok_f, out_f = _run_net(["git", "fetch", "--prune", name], timeout=40)
        if not ok_f:
            return 200, {"ok": False, "stage": "fetch", "kind": _classify_git_error(out_f), "message": out_f[:600]}
        branch = (body.get("branch") or _branch() or "main").strip()
        rb = name + "/" + branch
        if not sh(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/" + rb]):
            head = sh(["git", "rev-parse", "--abbrev-ref", name + "/HEAD"])  # e.g. origin/main
            if head and "/" in head:
                branch = head.split("/", 1)[1]
                rb = name + "/" + branch
        if not sh(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/" + rb]):
            return 200, {"ok": False, "message": "the remote has no branch to pull in yet"}
        ok, out = sh_full(["git", "checkout", "-B", branch, rb])
        return 200, {"ok": ok, "output": out, "branch": branch}

    if action == "push":
        branch = _branch()
        base = ["git", "push"] + (["--dry-run"] if body.get("dry") else []) + (["--force"] if body.get("force") else [])
        if _upstream():
            ok, out = sh_full(base)
        else:
            ok, out = sh_full(base + ["-u", "origin", branch])
        if body.get("dry"):
            return 200, {"ok": ok, "dry": True,
                         "output": ("dry run: " + (out or "push would succeed")) if ok
                                   else (out or "dry run failed")}
        result = {"ok": ok, "output": out}
        tag = (body.get("tag") or "").strip()
        if ok and tag:
            if not valid_branch(tag):
                result["tagError"] = "invalid tag name"
            else:
                t = dedup_tag(tag)
                sh(["git", "tag", t])
                tok, tout = sh_full(["git", "push", "origin", t])
                result["tag"] = t
                result["tagOk"] = tok
                result["tagOutput"] = tout
        return 200, result

    if action == "abort":
        sh(["git", "merge", "--abort"])
        sh(["git", "rebase", "--abort"])
        return 200, {"ok": True}

    if action == "switch":
        b = body.get("branch")
        if not valid_branch(b):
            return 400, {"ok": False, "error": "bad branch"}
        short = b.split("/", 1)[1] if b.startswith("origin/") else b
        ok, out = sh_full(["git", "checkout", short])
        return 200, {"ok": ok, "output": out}

    if action == "create":
        b = body.get("name")
        if not valid_branch(b):
            return 400, {"ok": False, "error": "bad branch name"}
        ok, out = sh_full(["git", "checkout", "-b", b])
        return 200, {"ok": ok, "output": out}

    if action == "remote":
        url = (body.get("url") or "").strip()
        name = (body.get("name") or "origin").strip()
        if not url:
            return 400, {"ok": False, "error": "empty url"}
        if not re.match(r"^[A-Za-z0-9._-]{1,40}$", name):
            return 400, {"ok": False, "error": "bad remote name"}
        remotes = (sh(["git", "remote"]) or "").split()
        if name in remotes:
            ok, out = sh_full(["git", "remote", "set-url", name, url])
        else:
            ok, out = sh_full(["git", "remote", "add", name, url])
        return 200, {"ok": ok, "output": out, "name": name}

    if action == "remote-remove":
        name = (body.get("name") or "origin").strip()
        remotes = (sh(["git", "remote"]) or "").split()
        if name not in remotes:
            return 200, {"ok": True, "output": "no such remote"}
        ok, out = sh_full(["git", "remote", "remove", name])
        return 200, {"ok": ok, "output": out}

    if action == "set-upstream":
        up = (body.get("upstream") or "").strip()
        if not up:
            ok, out = sh_full(["git", "branch", "--unset-upstream"])
            return 200, {"ok": ok, "output": out}
        if not valid_branch(up) or "/" not in up:
            return 400, {"ok": False, "error": "upstream must be REMOTE/BRANCH, e.g. origin/main"}
        ok, out = sh_full(["git", "branch", "--set-upstream-to=" + up])
        return 200, {"ok": ok, "output": out}

    if action == "identity":
        name = (body.get("name") or "").strip()
        email = (body.get("email") or "").strip()
        if not name or not email or "\n" in name or "\n" in email \
                or len(name) > 120 or len(email) > 160:
            return 400, {"ok": False, "error": "name and email required"}
        ok1, o1 = sh_full(["git", "config", "user.name", name])
        ok2, o2 = sh_full(["git", "config", "user.email", email])
        return 200, {"ok": ok1 and ok2, "output": (o1 + " " + o2).strip()}

    return 400, {"ok": False, "error": "unknown action"}


def do_write(action, body):
    if session.aider_status()["active"]:
        return 423, {"ok": False, "error": "locked", "reason": "aider is running"}

    f = body.get("file")
    h = body.get("hash")

    if action == "stage":
        if not valid_file(f):
            return 400, {"ok": False, "error": "bad file"}
        reason = _commit_block_reason(f)
        if reason:
            return 200, {"ok": False, "error": "protected", "file": f,
                         "reason": reason, "protected": [{"file": f, "reason": reason}]}
        return 200, {"ok": sh(["git", "add", "--", f]) is not None}

    if action == "unstage":
        if not valid_file(f):
            return 400, {"ok": False, "error": "bad file"}
        return 200, {"ok": sh(["git", "restore", "--staged", "--", f]) is not None}

    if action == "commit":
        msg = (body.get("message") or "").strip()
        if not msg:
            return 400, {"ok": False, "error": "empty message"}
        # Final guard: refuse if anything currently staged is on the never-commit
        # list (e.g. force-added or already-tracked-by-accident). Lists the
        # offenders so the UI can show which to unstage.
        staged = [ln for ln in (sh(["git", "diff", "--cached", "--name-only"]) or "").splitlines() if ln.strip()]
        blocked = _protected_in(staged)
        if blocked:
            names = ", ".join(b["file"] for b in blocked)
            return 200, {"ok": False, "error": "protected-staged", "protected": blocked,
                         "output": "refused — unstage protected file(s) first: " + names}
        ok, out = sh_full(["git", "commit", "-m", msg[:500]])
        return 200, {"ok": ok, "output": out}

    if action == "discard":
        if not valid_file(f):
            return 400, {"ok": False, "error": "bad file"}
        out = sh(["git", "stash", "push", "-m", "discard " + f, "--", f])
        return 200, {"ok": out is not None, "output": out,
                     "stashed": bool(out and "No local changes" not in out)}

    if action == "restore":
        if not valid_file(f) or not (h and HEX.match(h)):
            return 400, {"ok": False, "error": "bad args"}
        sh(["git", "stash", "push", "-m", "pre-restore " + f, "--", f])
        return 200, {"ok": sh(["git", "checkout", h, "--", f]) is not None}

    if action == "reset-hard":
        if not (h and HEX.match(h)):
            return 400, {"ok": False, "error": "bad hash"}
        sh(["git", "stash", "push", "-u", "-m", "pre-reset"])
        return 200, {"ok": sh(["git", "reset", "--hard", h]) is not None}

    if action == "undo":
        return 200, {"ok": sh(["git", "reset", "--soft", "HEAD~1"]) is not None}

    if action == "tag":
        name = body.get("name") or ""
        if not (h and HEX.match(h)) or not TAGRE.match(name):
            return 400, {"ok": False, "error": "bad args"}
        return 200, {"ok": sh(["git", "tag", name, h]) is not None}

    return 404, {"ok": False, "error": "unknown action"}

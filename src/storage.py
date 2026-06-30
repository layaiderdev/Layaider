#!/usr/bin/env python3
"""Layaider local-state store: blueprints, keys, model lists, and aider
option registries, kept under config.state_dir() so Layaider owns its state on
its own native paths.
"""

import os
import re
import json
from pathlib import Path

import config


def aider_dir():
    """Native state directory for blueprints/keys/lists.

    Lives at state_dir/aider. Installs created before the rename kept this data
    under state_dir/orchestrator; migrate it once, in place, on first access so
    existing blueprints and keys carry over with no user action.
    """
    d = config.state_dir() / "aider"
    if not d.exists():
        legacy = config.state_dir() / "orchestrator"
        if legacy.is_dir():
            try:
                legacy.rename(d)
            except Exception:
                pass
    return d


# Back-compat alias for any external caller; prefer aider_dir().
orch_dir = aider_dir


AIDER_LISTS = {
    "models": {"label": "Models", "fields": [
        {"name": "id", "type": "text"},
        {"name": "model_string", "type": "text", "suggest": "modelstrings"},
        {"name": "arch", "type": "score"},
        {"name": "editor", "type": "score"},
        {"name": "weak", "type": "score"},
    ]},
    "modelstrings": {"label": "Model strings", "fields": [
        {"name": "model_string", "type": "text"},
        {"name": "description", "type": "text"},
    ]},
    "flags": {"label": "Flag sets", "fields": [
        {"name": "id", "type": "text"},
        {"name": "flags", "type": "text"},
        {"name": "description", "type": "text"},
    ]},
    "aiderflags": {"label": "Aider-flag catalog", "fields": [
        {"name": "flag", "type": "text"},
        {"name": "takes_value", "type": "bool01"},
        {"name": "description", "type": "text"},
    ]},
    "files": {"label": "Files", "fields": [
        {"name": "id", "type": "text"},
        {"name": "path", "type": "text"},
        {"name": "description", "type": "text"},
    ]},
    "filemodes": {"label": "File modes", "fields": [
        {"name": "modeid", "type": "text"},
        {"name": "flag", "type": "text"},
    ]},
    "envvars": {"label": "Env-var catalog", "fields": [
        {"name": "ENV_VAR", "type": "text"},
        {"name": "description", "type": "text"},
    ]},
}

AIDER_LIST_ORDER = ["models", "modelstrings", "flags", "aiderflags", "files", "filemodes", "envvars"]

ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

def _opt(key, group, typ, help, enum=None, safe=None):
    o = {"key": key, "group": group, "type": typ, "help": help}
    if enum:
        o["enum"] = enum
    if safe:
        o["safe"] = safe
    return o

AIDER_OPTIONS = [
    _opt("edit-format", "Models & editing", "enum", "Edit format the model uses.",
         enum=["diff", "whole", "udiff", "udiff-simple", "diff-fenced", "editor-diff", "editor-whole"]),
    _opt("editor-edit-format", "Models & editing", "text", "Edit format for the editor model."),
    _opt("chat-mode", "Models & editing", "enum", "Default chat mode.",
         enum=["code", "ask", "architect", "help", "context"]),
    _opt("architect", "Models & editing", "bool", "Use architect edit format for the main chat."),
    _opt("auto-accept-architect", "Models & editing", "bool", "Auto-accept architect changes."),
    _opt("reasoning-effort", "Models & editing", "text", "reasoning_effort API param (model-dependent)."),
    _opt("thinking-tokens", "Models & editing", "text", "Thinking token budget; 0 disables."),
    _opt("show-model-warnings", "Models & editing", "bool", "Warn about models lacking metadata."),
    _opt("check-model-accepts-settings", "Models & editing", "bool", "Check model accepts reasoning/thinking settings."),
    _opt("max-chat-history-tokens", "Models & editing", "int", "Soft token limit before history summarization."),

    _opt("alias", "Model aliases", "list", 'Aliases, one per line, e.g. "gem: gemini/gemini-2.5-flash".'),

    _opt("read", "Context & files", "list", "Read-only files always in context, one per line (e.g. CONVENTIONS.md)."),
    _opt("map-tokens", "Context & files", "int", "Tokens for the repo map; 0 disables."),
    _opt("map-refresh", "Context & files", "enum", "How often the repo map refreshes.",
         enum=["auto", "always", "files", "manual"]),
    _opt("map-multiplier-no-files", "Context & files", "text", "Map-token multiplier when no files are specified."),

    _opt("auto-commits", "Git & commits", "bool", "Auto-commit LLM changes.",
         safe="Your workflow keeps this off — an auto-commit once made a stub overwrite permanent."),
    _opt("dirty-commits", "Git & commits", "bool", "Commit when the repo is found dirty."),
    _opt("attribute-author", "Git & commits", "bool", "Attribute aider changes in the git author name."),
    _opt("attribute-committer", "Git & commits", "bool", "Attribute aider in the git committer name."),
    _opt("attribute-commit-message-author", "Git & commits", "bool", "Prefix 'aider: ' when aider authored."),
    _opt("attribute-commit-message-committer", "Git & commits", "bool", "Prefix 'aider: ' on all commit messages."),
    _opt("attribute-co-authored-by", "Git & commits", "bool", "Use the Co-authored-by trailer."),
    _opt("git-commit-verify", "Git & commits", "bool", "Run git pre-commit hooks (off = --no-verify)."),
    _opt("commit-prompt", "Git & commits", "text", "Custom prompt for generated commit messages."),
    _opt("dry-run", "Git & commits", "bool", "Perform a dry run without modifying files."),
    _opt("git", "Git & commits", "bool", "Look for a git repo."),
    _opt("gitignore", "Git & commits", "bool", "Add .aider* to .gitignore."),
    _opt("add-gitignore-files", "Git & commits", "bool", "Allow editing files listed in .gitignore."),
    _opt("aiderignore", "Git & commits", "text", "Path to the aider ignore file."),
    _opt("subtree-only", "Git & commits", "bool", "Only consider files in the current subtree."),
    _opt("skip-sanity-check-repo", "Git & commits", "bool", "Skip the git repo sanity check."),
    _opt("watch-files", "Git & commits", "bool", "Watch files for AI coding comments."),

    _opt("auto-lint", "Lint & test", "bool", "Lint automatically after changes."),
    _opt("lint-cmd", "Lint & test", "list", 'Lint commands, one per line, e.g. "python: flake8".'),
    _opt("auto-test", "Lint & test", "bool", "Run tests automatically after changes."),
    _opt("test-cmd", "Lint & test", "text", "Command to run tests."),

    _opt("cache-prompts", "Cache", "bool", "Enable prompt caching."),
    _opt("cache-keepalive-pings", "Cache", "int", "Pings at 5-min intervals to keep the cache warm."),

    _opt("stream", "Output & UX", "bool", "Stream responses."),
    _opt("pretty", "Output & UX", "bool", "Pretty, colorized output."),
    _opt("dark-mode", "Output & UX", "bool", "Colors for a dark terminal."),
    _opt("light-mode", "Output & UX", "bool", "Colors for a light terminal."),
    _opt("code-theme", "Output & UX", "text", "Markdown code theme (e.g. monokai)."),
    _opt("show-diffs", "Output & UX", "bool", "Show diffs when committing."),
    _opt("suggest-shell-commands", "Output & UX", "bool", "Suggest shell commands."),
    _opt("fancy-input", "Output & UX", "bool", "Fancy input with history/completion."),
    _opt("multiline", "Output & UX", "bool", "Multi-line input mode."),
    _opt("notifications", "Output & UX", "bool", "Terminal bell when responses are ready."),
    _opt("notifications-command", "Output & UX", "text", "Command to run for notifications."),
    _opt("vim", "Output & UX", "bool", "Use vim keybindings in the chat."),

    _opt("verify-ssl", "Network", "bool", "Verify SSL certs when connecting to models."),
    _opt("timeout", "Network", "int", "Timeout in seconds for API calls."),
    _opt("encoding", "Network", "text", "Encoding for reading/writing files."),

    _opt("input-history-file", "History", "text", "Chat input history file."),
    _opt("chat-history-file", "History", "text", "Chat history file."),
    _opt("restore-chat-history", "History", "bool", "Restore previous chat history on launch."),
    _opt("llm-history-file", "History", "text", "Log the LLM conversation to this file."),
]

OPTION_BY_KEY = {o["key"]: o for o in AIDER_OPTIONS}

AIDER_DOCS_URL = "https://aider.chat/docs/config/options.html"

OPTION_DEFAULTS = {
    "edit-format": "depends on model", "editor-edit-format": "depends on editor model",
    "chat-mode": "code", "architect": "false", "auto-accept-architect": "true",
    "reasoning-effort": "not set", "thinking-tokens": "not set",
    "show-model-warnings": "true", "check-model-accepts-settings": "true",
    "max-chat-history-tokens": "model-dependent",
    "alias": "none", "read": "none",
    "map-tokens": "1024", "map-refresh": "auto", "map-multiplier-no-files": "2",
    "auto-commits": "true", "dirty-commits": "true",
    "attribute-author": "see docs", "attribute-committer": "see docs",
    "attribute-commit-message-author": "false", "attribute-commit-message-committer": "false",
    "attribute-co-authored-by": "true", "git-commit-verify": "false",
    "commit-prompt": "not set", "dry-run": "false", "git": "true", "gitignore": "true",
    "add-gitignore-files": "false", "aiderignore": ".aiderignore", "subtree-only": "false",
    "skip-sanity-check-repo": "false", "watch-files": "false",
    "auto-lint": "true", "lint-cmd": "none", "auto-test": "false", "test-cmd": "none",
    "cache-prompts": "false", "cache-keepalive-pings": "0",
    "stream": "true", "pretty": "true", "dark-mode": "false", "light-mode": "false",
    "code-theme": "default", "show-diffs": "false", "suggest-shell-commands": "true",
    "fancy-input": "true", "multiline": "false", "notifications": "false",
    "notifications-command": "not set", "vim": "false",
    "verify-ssl": "true", "timeout": "none", "encoding": "utf-8",
    "input-history-file": ".aider.input.history", "chat-history-file": ".aider.chat.history.md",
    "restore-chat-history": "false", "llm-history-file": "not set",
}

for _o in AIDER_OPTIONS:
    _o["cli"] = "--" + _o["key"]
    _o["default"] = OPTION_DEFAULTS.get(_o["key"], "")

KEYS_FIELDS = ["nick", "var", "token", "desc"]

BLUEPRINT_FIELDS = ["name", "desc", "arch", "editor", "weak",
                    "arch_key", "editor_key", "weak_key", "flags", "files"]

_BP_ROLE_KEYS = (("arch", "arch_key"), ("editor", "editor_key"), ("weak", "weak_key"))


def _list_path(name):
    return aider_dir() / (name + ".list")


def read_list(name):
    spec = AIDER_LISTS.get(name)
    if not spec:
        return None
    n = len(spec["fields"])
    rows = []
    p = _list_path(name)
    if p.is_file():
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            parts = line.split("|")
            rows.append((parts + [""] * n)[:n])
    return rows


def write_list(name, rows):
    aider_dir().mkdir(parents=True, exist_ok=True)
    lines = ["|".join(r) for r in rows]
    _list_path(name).write_text("\n".join(lines) + ("\n" if lines else ""))


def _validate_row(name, values):
    fields = AIDER_LISTS[name]["fields"]
    if len(values) != len(fields):
        return "wrong number of fields"
    for f, v in zip(fields, values):
        if "|" in v or "\n" in v or "\r" in v:
            return "%s: no pipe or newline allowed" % f["name"]
        if f["type"] == "score" and not re.match(r"^[0-9]$", v):
            return "%s: must be a single digit 0-9" % f["name"]
        if f["type"] == "bool01" and v not in ("0", "1"):
            return "%s: must be 0 or 1" % f["name"]
    if not values[0].strip():
        return "%s is required" % fields[0]["name"]
    return None


def mask_secret(t):
    n = len(t)
    if n == 0:
        return ""
    if n <= 9:
        return t[:1] + "###"
    return t[:6] + "###" + t[-3:]


def _keys_path():
    return aider_dir() / "keys.list"


def read_keys_raw():
    p = _keys_path()
    rows = []
    if p.is_file():
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            f = (line.split("|") + [""] * 4)[:4]
            rows.append(dict(zip(KEYS_FIELDS, f)))
    return rows


def read_keys():
    # client-facing: token masked, never the raw secret
    out = []
    for r in read_keys_raw():
        if not r["nick"]:
            continue
        out.append({
            "nick": r["nick"], "var": r["var"], "desc": r["desc"],
            "masked": mask_secret(r["token"]), "present": bool(r["token"].strip()),
        })
    return out


def keys_var_index():
    # nick -> supplier env var, for resolving a blueprint's referenced keys
    return {r["nick"]: r["var"] for r in read_keys_raw() if r["nick"]}


def keys_info_index():
    # nick -> {var, present}, for validation and readiness
    return {r["nick"]: {"var": r["var"], "present": bool(r["token"].strip())}
            for r in read_keys_raw() if r["nick"]}


def _bp_role_model(b, role):
    # effective model id for a role: its own, else architect's (editor/weak inherit)
    m = (b.get(role) or "").strip()
    if not m and role != "arch":
        m = (b.get("arch") or "").strip()
    return m


def write_keys(rows):
    aider_dir().mkdir(parents=True, exist_ok=True)
    lines = ["|".join((r.get(k, "") or "") for k in KEYS_FIELDS) for r in rows]
    p = _keys_path()
    p.write_text("\n".join(lines) + ("\n" if lines else ""))
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def set_key(nick, var, token, desc):
    rows = read_keys_raw()
    for r in rows:
        if r["nick"] == nick:
            r["var"] = var
            if token != "":          # blank token on edit = keep existing secret
                r["token"] = token
            r["desc"] = desc
            write_keys(rows)
            return
    rows.append({"nick": nick, "var": var, "token": token, "desc": desc})
    write_keys(rows)


def delete_key(nick):
    write_keys([r for r in read_keys_raw() if r["nick"] != nick])


def read_blueprints():
    p = aider_dir() / "blueprints.list"
    rows = []
    if p.is_file():
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            f = (line.split("|") + [""] * 10)[:10]
            rows.append(dict(zip(BLUEPRINT_FIELDS, f)))
    return rows


def write_blueprints(rows):
    aider_dir().mkdir(parents=True, exist_ok=True)
    lines = ["|".join(r[k] for k in BLUEPRINT_FIELDS) for r in rows]
    (aider_dir() / "blueprints.list").write_text("\n".join(lines) + ("\n" if lines else ""))


def _ids(name):
    return {r[0] for r in (read_list(name) or [])}


def _validate_blueprint(b):
    for k in BLUEPRINT_FIELDS:
        v = b.get(k, "")
        if "|" in v or "\n" in v or "\r" in v:
            return "%s: no pipe or newline allowed" % k
    if not b.get("name", "").strip():
        return "name is required"
    if not b.get("arch", "").strip():
        return "architect model is required"
    mids = _ids("models")
    for role in ("arch", "editor", "weak"):
        v = b.get(role, "").strip()
        if v and v not in mids:
            return "%s model '%s' is not in the models list" % (role, v)
    fids = _ids("flags")
    for fid in [x.strip() for x in b.get("flags", "").split(",") if x.strip()]:
        if fid not in fids:
            return "flag set '%s' is not in the flag-sets list" % fid
    file_ids, mode_ids = _ids("files"), _ids("filemodes")
    for spec in [x.strip() for x in b.get("files", "").split(",") if x.strip()]:
        fid = spec.split(":", 1)[0]
        mid = spec.split(":", 1)[1] if ":" in spec else ""
        if fid not in file_ids:
            return "file '%s' is not in the files list" % fid
        if mid and mid not in mode_ids:
            return "file mode '%s' is not in the file-modes list" % mid
    kinfo = keys_info_index()
    for role, kf in _BP_ROLE_KEYS:
        nick = b.get(kf, "").strip()
        if not nick:
            continue
        info = kinfo.get(nick)
        if not info:
            return "%s key '%s' is not in the keys list" % (role, nick)
        ms = _list_get("models", _bp_role_model(b, role), 1)
        if ms:
            ev = provider_env_var(ms)
            if info["var"] != ev:
                return "%s key '%s' (%s) does not match its model provider (%s)" % (
                    role, nick, info["var"], ev)
    return None


def _bp_options_path():
    return aider_dir() / "blueprint_options.json"


def _defaults_path_aider():
    return aider_dir() / "defaults.json"


def _read_json(p, fallback):
    if p.is_file():
        try:
            d = json.loads(p.read_text())
            return d if isinstance(d, dict) else fallback
        except Exception:
            return fallback
    return fallback


def read_bp_options():
    return _read_json(_bp_options_path(), {})


def write_bp_options(d):
    aider_dir().mkdir(parents=True, exist_ok=True)
    _bp_options_path().write_text(json.dumps(d, indent=2))


def read_defaults_aider():
    d = _read_json(_defaults_path_aider(), {})
    base = d.get("base") if isinstance(d.get("base"), dict) else {}
    override = d.get("override") if isinstance(d.get("override"), dict) else {}
    return {"base": base, "override": override}


def write_defaults_aider(d):
    aider_dir().mkdir(parents=True, exist_ok=True)
    _defaults_path_aider().write_text(json.dumps(d, indent=2))


def _validate_options(values):
    if not isinstance(values, dict):
        return "options must be an object"
    for k, v in values.items():
        o = OPTION_BY_KEY.get(k)
        if not o:
            return "unknown option '%s'" % k
        t = o["type"]
        if t == "bool":
            if not isinstance(v, bool):
                return "%s must be true or false" % k
        elif t == "int":
            if not isinstance(v, int) or isinstance(v, bool):
                return "%s must be a whole number" % k
        elif t == "list":
            if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
                return "%s must be a list of strings" % k
            if any("\n" in x or "\r" in x for x in v):
                return "%s items cannot contain newlines" % k
        elif t == "enum":
            if not isinstance(v, str) or v not in o.get("enum", []):
                return "%s must be one of: %s" % (k, ", ".join(o.get("enum", [])))
        else:
            if not isinstance(v, str) or "\n" in v or "\r" in v:
                return "%s must be a single line of text" % k
    return None


def _list_get(name, key, col):
    if not key:
        return ""
    for r in (read_list(name) or []):
        if r and r[0] == key:
            return r[col] if col < len(r) else ""
    return ""


def expand_flags(flags_csv):
    out = []
    for fid in [x.strip() for x in (flags_csv or "").split(",") if x.strip()]:
        s = _list_get("flags", fid, 1)
        if s:
            out.append(s)
    return " ".join(out)


def expand_files(files_csv):
    out = []
    for spec in [x.strip() for x in (files_csv or "").split(",") if x.strip()]:
        fid = spec.split(":", 1)[0]
        mid = spec.split(":", 1)[1] if ":" in spec else ""
        path = _list_get("files", fid, 1)
        if not path:
            continue
        flag = _list_get("filemodes", mid, 1) if mid else ""
        if not flag:
            flag = "--read"
        out.append(flag + " " + path)
    return " ".join(out)


def blueprint_effective(i):
    bps = read_blueprints()
    if not isinstance(i, int) or i < 0 or i >= len(bps):
        return None
    b = bps[i]
    defs = read_defaults_aider()
    bo = read_bp_options().get(b["name"], {})
    roles = {}
    arch = _list_get("models", b["arch"], 1)
    if arch:
        roles["model"] = arch
    ed = _list_get("models", b["editor"], 1)
    if ed:
        roles["editor-model"] = ed
    wk = _list_get("models", b["weak"], 1)
    if wk:
        roles["weak-model"] = wk
    merged = {}
    merged.update(defs["base"])
    merged.update(roles)
    merged.update(bo)
    merged.update(defs["override"])
    return {
        "name": b["name"], "options": merged,
        "flags": expand_flags(b["flags"]), "files": expand_files(b["files"]),
        "layers": {"base": defs["base"], "roles": roles, "blueprint": bo, "override": defs["override"]},
    }


def do_aider_options(body):
    scope = body.get("scope")
    values = body.get("values") or {}
    err = _validate_options(values)
    if err:
        return 400, {"ok": False, "error": err}
    if scope == "blueprint":
        name = (body.get("name") or "").strip()
        if not name:
            return 400, {"ok": False, "error": "missing blueprint name"}
        d = read_bp_options()
        old = (body.get("oldName") or "").strip()
        if old and old != name:
            d.pop(old, None)
        if values:
            d[name] = values
        else:
            d.pop(name, None)
        write_bp_options(d)
    elif scope in ("base", "override"):
        d = read_defaults_aider()
        d[scope] = values
        write_defaults_aider(d)
    else:
        return 400, {"ok": False, "error": "unknown scope"}
    return 200, {"ok": True}


def do_aider_blueprint(body):
    op = body.get("op")
    rows = read_blueprints()
    if op in ("add", "update"):
        raw = body.get("values") or {}
        b = {k: str(raw.get(k, "")) for k in BLUEPRINT_FIELDS}
        err = _validate_blueprint(b)
        if err:
            return 400, {"ok": False, "error": err}
        if op == "add":
            rows.append(b)
        else:
            i = body.get("index")
            if not isinstance(i, int) or i < 0 or i >= len(rows):
                return 400, {"ok": False, "error": "bad index"}
            old_name = rows[i]["name"]
            rows[i] = b
            if old_name != b["name"]:
                bo = read_bp_options()
                if old_name in bo:
                    bo[b["name"]] = bo.pop(old_name)
                    write_bp_options(bo)
    elif op == "delete":
        i = body.get("index")
        if not isinstance(i, int) or i < 0 or i >= len(rows):
            return 400, {"ok": False, "error": "bad index"}
        removed = rows.pop(i)
        bo = read_bp_options()
        if removed["name"] in bo:
            bo.pop(removed["name"])
            write_bp_options(bo)
    elif op == "clone":
        i = body.get("index")
        if not isinstance(i, int) or i < 0 or i >= len(rows):
            return 400, {"ok": False, "error": "bad index"}
        src = rows[i]
        existing = {r["name"] for r in rows}
        base = src["name"] + " copy"
        name = base
        n = 2
        while name in existing:
            name = base + " " + str(n)
            n += 1
        clone = dict(src)
        clone["name"] = name
        rows.insert(i + 1, clone)
        bo = read_bp_options()
        if src["name"] in bo:
            bo[name] = dict(bo[src["name"]])
            write_bp_options(bo)
    elif op in ("default", "move"):
        i = body.get("index")
        to = 0 if op == "default" else body.get("to")
        if (not isinstance(i, int) or i < 0 or i >= len(rows)
                or not isinstance(to, int) or to < 0 or to >= len(rows)):
            return 400, {"ok": False, "error": "bad index"}
        rows.insert(to, rows.pop(i))
    else:
        return 400, {"ok": False, "error": "unknown op"}
    try:
        write_blueprints(rows)
    except Exception as e:
        return 200, {"ok": False, "output": str(e)}
    return 200, {"ok": True}


def blueprint_env(b):
    """Resolve a blueprint's per-role keys to {ENV_VAR: token} for the native
    aider adapter. Reads raw tokens from the 0600 key store; the caller writes
    them to a 0600 env file outside the repo and never into process args."""
    raw = {r["nick"]: r for r in read_keys_raw() if r["nick"]}
    env = {}
    for _role, key_field in _BP_ROLE_KEYS:
        nick = (b.get(key_field) or "").strip()
        if not nick:
            continue
        rec = raw.get(nick)
        if rec and rec.get("var") and rec.get("token"):
            env[rec["var"]] = rec["token"]
    return env


def provider_env_var(model_str):
    # first path segment uppercased + _API_KEY (defaults to openai).
    provider = model_str.split("/", 1)[0] if "/" in model_str else "openai"
    return provider.upper() + "_API_KEY"


def _blueprint_readiness(b, key_info):
    # One chip per distinct provider env the blueprint needs. An env is "present"
    # when some role using it has a chosen key that exists, matches the provider,
    # and has its token set.
    needs, seen = [], set()
    for role, _kf in _BP_ROLE_KEYS:
        ms = _list_get("models", _bp_role_model(b, role), 1)
        if not ms:
            continue
        ev = provider_env_var(ms)
        if ev in seen:
            continue
        seen.add(ev)
        present = False
        for r2, kf2 in _BP_ROLE_KEYS:
            ms2 = _list_get("models", _bp_role_model(b, r2), 1)
            if not ms2 or provider_env_var(ms2) != ev:
                continue
            info = key_info.get((b.get(kf2) or "").strip())
            if info and info["var"] == ev and info["present"]:
                present = True
                break
        needs.append({"env": ev, "present": present})
    return needs


def aider_store():
    lists = {}
    for name in AIDER_LIST_ORDER:
        lists[name] = {
            "label": AIDER_LISTS[name]["label"],
            "fields": AIDER_LISTS[name]["fields"],
            "rows": read_list(name),
        }
    blueprints = read_blueprints()
    key_info = keys_info_index()
    for b in blueprints:
        b["readiness"] = _blueprint_readiness(b, key_info)
    return {
        "dir": str(aider_dir()), "exists": aider_dir().is_dir(), "order": AIDER_LIST_ORDER,
        "lists": lists,
        "blueprints": blueprints,
        "options_registry": AIDER_OPTIONS,
        "docs_url": AIDER_DOCS_URL,
        "blueprint_options": read_bp_options(),
        "defaults": read_defaults_aider(),
        "keys": {"path": str(_keys_path()), "rows": read_keys()},
    }


def do_aider_list(name, body):
    if name not in AIDER_LISTS:
        return 404, {"ok": False, "error": "unknown list"}
    op = body.get("op")
    rows = read_list(name)
    if op == "add":
        values = [str(x) for x in (body.get("values") or [])]
        err = _validate_row(name, values)
        if err:
            return 400, {"ok": False, "error": err}
        rows.append(values)
    elif op == "update":
        i = body.get("index")
        if not isinstance(i, int) or i < 0 or i >= len(rows):
            return 400, {"ok": False, "error": "bad index"}
        values = [str(x) for x in (body.get("values") or [])]
        err = _validate_row(name, values)
        if err:
            return 400, {"ok": False, "error": err}
        rows[i] = values
    elif op == "delete":
        i = body.get("index")
        if not isinstance(i, int) or i < 0 or i >= len(rows):
            return 400, {"ok": False, "error": "bad index"}
        rows.pop(i)
    elif op == "move":
        i, to = body.get("index"), body.get("to")
        if (not isinstance(i, int) or not isinstance(to, int) or i < 0 or i >= len(rows)
                or to < 0 or to >= len(rows)):
            return 400, {"ok": False, "error": "bad index"}
        rows.insert(to, rows.pop(i))
    else:
        return 400, {"ok": False, "error": "unknown op"}
    try:
        write_list(name, rows)
    except Exception as e:
        return 200, {"ok": False, "output": str(e)}
    return 200, {"ok": True}


def do_aider_keys(body):
    op = body.get("op")
    nick = (body.get("nick") or "").strip()
    if not nick or any(c in nick for c in "|\n\r"):
        return 400, {"ok": False, "error": "invalid key reference"}
    if op == "set":
        var = (body.get("var") or "").strip()
        if not ENV_NAME_RE.match(var):
            return 400, {"ok": False, "error": "invalid supplier var"}
        token = "" if body.get("token") is None else str(body.get("token"))
        desc = (body.get("desc") or "").strip()
        if any(c in (var + desc + token) for c in "\n\r") or "|" in (var + desc) or "|" in token:
            return 400, {"ok": False, "error": "no pipe or newline allowed in fields"}
        set_key(nick, var, token, desc)
    elif op == "delete":
        delete_key(nick)
    else:
        return 400, {"ok": False, "error": "unknown op"}
    return 200, {"ok": True}

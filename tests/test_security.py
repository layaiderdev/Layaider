#!/usr/bin/env python3
"""Layaider security and regression suite (stdlib unittest, no external deps).

Run on-device from the repo root:

    python3 tests/test_security.py
    # or
    python3 -m unittest -v tests.test_security

Coverage:
  - core.safe_path workspace-boundary enforcement (traversal, absolute, null,
    leading dash, symlink escape, sibling-prefix, missing root)
  - git pathspec validation (valid_file, valid_branch) and safe_fs confinement
  - repository discovery / active-repo state (config)
  - the parent-repository .gitignore guardrail (config.protect_parent_gitignore)
  - first-time initialization and project_hooks generation / fallback
  - secret redaction and 0600 key-file permissions
  - session lifecycle: engine-command quoting, status, and the no-session /
    unknown-blueprint paths (tmux-dependent launch is skipped without tmux)
  - a live static server: serves /public, never the install tree

git-dependent classes skip when git is unavailable; the full tmux launch skips
when tmux is unavailable. Everything else runs anywhere.
"""

import os
import sys
import json
import shlex
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import subprocess
from pathlib import Path

# Make the src/ package importable when the file is run directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import config            # noqa: E402
import core              # noqa: E402
import git as gitmod     # noqa: E402  (local alias; same module core imports)
import session           # noqa: E402
import storage           # noqa: E402
import servers           # noqa: E402
import api               # noqa: E402

HAVE_GIT = shutil.which("git") is not None
HAVE_TMUX = shutil.which("tmux") is not None


def _default_config():
    return json.loads(json.dumps(config.DEFAULT_CONFIG))


def _reset_config():
    config.set_config(_default_config())


def _git(args, cwd):
    subprocess.run(["git"] + args, cwd=str(cwd), check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    _git(["init"], path)
    _git(["config", "user.email", "t@t"], path)
    _git(["config", "user.name", "t"], path)
    (path / "README.md").write_text("hello\n")
    _git(["add", "README.md"], path)
    _git(["commit", "-m", "feat: init"], path)


def _base_config(tmp):
    cfg = _default_config()
    cfg["paths"]["install_path"] = str(tmp / "install")
    cfg["paths"]["git_workspace_root"] = str(tmp / "workspace")
    cfg["paths"]["state_dir"] = str(tmp / "state")
    for sub in ("install", "workspace", "state"):
        (tmp / sub).mkdir(parents=True, exist_ok=True)
    return cfg


class SafePathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "ws"
        (self.root / "sub").mkdir(parents=True)
        (self.root / "sub" / "f.txt").write_text("x")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_allows_inside(self):
        self.assertEqual(core.safe_path(self.root, "sub/f.txt"),
                         (self.root / "sub" / "f.txt").resolve())

    def test_empty_is_root(self):
        self.assertEqual(core.safe_path(self.root, ""), self.root.resolve())

    def test_blocks_parent_traversal(self):
        for bad in ["../etc/passwd", "..", "sub/../../escape", "a/../../b"]:
            with self.assertRaises(core.PathValidationError):
                core.safe_path(self.root, bad)

    def test_blocks_absolute(self):
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, "/etc/passwd")

    def test_blocks_leading_dash(self):
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, "-rf")

    def test_blocks_null_byte(self):
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, "a\x00b")

    def test_blocks_non_string(self):
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, 123)

    def test_blocks_symlink_escape(self):
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "secret").write_text("s")
        try:
            os.symlink(str(outside), str(self.root / "link"))
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("symlinks unsupported here")
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, "link/secret")

    def test_blocks_sibling_prefix(self):
        # The legacy str.startswith() check let "ws-evil" pass the "ws" prefix.
        sibling = self.tmp / "ws-evil"
        sibling.mkdir()
        (sibling / "x").write_text("x")
        try:
            os.symlink(str(sibling), str(self.root / "evil"))
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("symlinks unsupported here")
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.root, "evil/x")

    def test_missing_root_raises(self):
        with self.assertRaises(core.PathValidationError):
            core.safe_path(self.tmp / "nope", "x")


class GitPathspecValidationTests(unittest.TestCase):
    def test_valid_file(self):
        self.assertTrue(gitmod.valid_file("src/app.js"))
        for bad in ["", "-x", "../etc", None, 123]:
            self.assertFalse(gitmod.valid_file(bad))

    def test_valid_branch(self):
        self.assertTrue(gitmod.valid_branch("feature/new-thing"))
        for bad in ["", "-x", "a..b", None, "bad branch!"]:
            self.assertFalse(gitmod.valid_branch(bad))


@unittest.skipUnless(HAVE_GIT, "git not available")
class RepoDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cfg = _base_config(self.tmp)
        ws = Path(cfg["paths"]["git_workspace_root"])
        _init_repo(ws / "repoA")
        _init_repo(ws / "repoB")
        (ws / "plain").mkdir()
        config.set_config(cfg)

    def tearDown(self):
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_discovers_git_repos_only(self):
        names = {r["name"] for r in config.discover_repos()}
        self.assertIn("repoA", names)
        self.assertIn("repoB", names)
        self.assertNotIn("plain", names)

    def test_is_git_repo(self):
        ws = Path(config.git_workspace_root())
        self.assertTrue(config.is_git_repo(ws / "repoA"))
        self.assertFalse(config.is_git_repo(ws / "plain"))

    def test_set_active_accepts_repo_rejects_plain(self):
        ws = Path(config.git_workspace_root())
        self.assertTrue(config.set_active(str(ws / "repoA")))
        self.assertTrue(os.path.samefile(config.active_repo(), str(ws / "repoA")))
        self.assertFalse(config.set_active(str(ws / "plain")))

    def test_safe_fs_confined_to_active_repo(self):
        ws = Path(config.git_workspace_root())
        config.set_active(str(ws / "repoA"))
        self.assertIsNotNone(gitmod.safe_fs("README.md"))
        self.assertIsNone(gitmod.safe_fs("../repoB/README.md"))
        self.assertIsNone(gitmod.safe_fs("/etc/passwd"))


@unittest.skipUnless(HAVE_GIT, "git not available")
class GitignoreGuardrailTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_nested_writes_block_and_is_idempotent(self):
        parent = self.tmp / "parent"
        _init_repo(parent)
        install = parent / "layaider"
        install.mkdir()
        r1 = config.protect_parent_gitignore(str(install))
        self.assertTrue(r1["nested"])
        self.assertTrue(r1["wrote"])
        gi = (parent / ".gitignore").read_text()
        self.assertIn(config.GITIGNORE_BEGIN, gi)
        self.assertIn("/layaider/", gi)
        r2 = config.protect_parent_gitignore(str(install))
        self.assertTrue(r2.get("already"))
        self.assertEqual((parent / ".gitignore").read_text().count(config.GITIGNORE_BEGIN), 1)

    def test_no_enclosing_repo_is_not_nested(self):
        install = self.tmp / "standalone"
        install.mkdir()
        r = config.protect_parent_gitignore(str(install))
        # On a dev machine the temp/home tree may itself live inside a git
        # checkout (or / is a repo, per guide 1.3), in which case the guardrail
        # correctly reports nested. Assert against the actual git reality so
        # this passes both in CI (temp outside any repo) and during development.
        top = config._git_toplevel(install)
        if top is None:
            self.assertFalse(r["nested"])
        else:
            self.assertTrue(r["nested"])

    def test_install_is_repo_top_is_not_nested(self):
        install = self.tmp / "selftop"
        _init_repo(install)
        r = config.protect_parent_gitignore(str(install))
        self.assertFalse(r["nested"])


class ConfigInitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_validate_directory_creates_and_rejects_empty(self):
        out = config.validate_directory(str(self.tmp / "made"), create=True)
        self.assertTrue(Path(out).is_dir())
        with self.assertRaises(config.ConfigError):
            config.validate_directory("", create=True)

    def test_first_time_init_noninteractive(self):
        install = self.tmp / "inst"
        ws = self.tmp / "ws"
        cfg = config.run_first_time_init(
            app_root=str(install), interactive=False,
            answers={"install_path": str(install), "git_workspace_root": str(ws)})
        self.assertTrue((install / "config.json").is_file())
        self.assertTrue((install / "project_hooks.py").is_file())
        self.assertEqual(cfg["session"]["name"], "la-aider")
        _, configured = config.load_config(app_root=str(install))
        self.assertTrue(configured)

    def test_unconfigured_default(self):
        _, configured = config.load_config(app_root=str(self.tmp))
        self.assertFalse(configured)

    def test_ensure_project_hooks_generates_once(self):
        hp = self.tmp / "project_hooks.py"
        _, created = config.ensure_project_hooks(hp)
        self.assertTrue(created)
        self.assertTrue(hp.is_file())
        _, created2 = config.ensure_project_hooks(hp)
        self.assertFalse(created2)

    def test_broken_hooks_fall_back_to_noop(self):
        install = self.tmp / "inst2"
        install.mkdir()
        (install / "project_hooks.py").write_text("(((  not valid python\n")
        cfg = _default_config()
        cfg["paths"]["install_path"] = str(install)
        cfg["paths"]["state_dir"] = str(self.tmp / "st")
        config.set_config(cfg)
        hooks = config.load_project_hooks()
        self.assertEqual(hooks.list_services({}), [])
        self.assertFalse(hooks.start_service({}, "x")["ok"])


class SecretAndStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        config.set_config(_base_config(self.tmp))

    def tearDown(self):
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_redact_secrets(self):
        text = "run --api-key sk-or-v1-ABCDEF123456 then token=supersecretvalue99"
        red = session.redact_secrets(text)
        self.assertNotIn("sk-or-v1-ABCDEF123456", red)
        self.assertNotIn("supersecretvalue99", red)
        self.assertIn("***", red)

    def test_state_store_under_state_dir(self):
        self.assertEqual(Path(storage.aider_dir()), config.state_dir() / "aider")

    def test_keys_masked_never_raw(self):
        storage.set_key("openai", "OPENAI_API_KEY", "sk-secret-tokenvalue123", "desc")
        keys = storage.read_keys()
        rec = [k for k in keys if k["nick"] == "openai"][0]
        self.assertTrue(rec["present"])
        self.assertNotIn("sk-secret-tokenvalue123", json.dumps(keys))

    def test_keys_file_mode_600(self):
        storage.set_key("openai", "OPENAI_API_KEY", "tok", "d")
        mode = os.stat(str(storage._keys_path())).st_mode & 0o777
        # No group/other access to the secret store.
        self.assertEqual(mode & 0o077, 0)

    def test_list_roundtrip(self):
        storage.write_list("modelstrings", [["openai/gpt-x", "a description"]])
        self.assertEqual(storage.read_list("modelstrings"),
                         [["openai/gpt-x", "a description"]])


class ServerRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        config.set_config(_base_config(self.tmp))

    def tearDown(self):
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_registry_under_state_dir(self):
        # Lives under Layaider's own state dir — never any external tool's config.
        self.assertEqual(Path(servers.registry_path()), config.state_dir() / "servers.json")

    def test_add_defaults_managed_and_generates_id(self):
        code, res = servers.add_server({"name": "web", "port": 8000})
        self.assertEqual(code, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(res["server"]["state"], "managed")
        self.assertTrue(res["server"]["id"])
        self.assertEqual(len(servers.list_servers()), 1)

    def test_add_requires_name_and_valid_port(self):
        self.assertEqual(servers.add_server({"port": 8000})[0], 400)
        self.assertEqual(servers.add_server({"name": "x", "port": 99999})[0], 400)

    def test_set_state_counts(self):
        sid = servers.add_server({"name": "a"})[1]["server"]["id"]
        servers.add_server({"name": "b"})
        servers.set_state([sid], "ignored")
        c = servers.counts(servers.list_servers())
        self.assertEqual(c["ignored"], 1)
        self.assertEqual(c["managed"], 1)

    def test_update_merges_keeps_id(self):
        sid = servers.add_server({"name": "a", "port": 8000})[1]["server"]["id"]
        res = servers.update_server(sid, {"name": "a2", "port": 8001})[1]
        self.assertEqual(res["server"]["id"], sid)
        self.assertEqual(res["server"]["name"], "a2")
        self.assertEqual(res["server"]["port"], 8001)

    def test_delete(self):
        sid = servers.add_server({"name": "a"})[1]["server"]["id"]
        servers.delete_server(sid)
        self.assertEqual(servers.list_servers(), [])

    def test_registry_mode_600(self):
        servers.add_server({"name": "a"})
        mode = os.stat(str(servers.registry_path())).st_mode & 0o777
        self.assertEqual(mode & 0o077, 0)


class SessionLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        config.set_config(_base_config(self.tmp))

    def tearDown(self):
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_inactive_without_session(self):
        st = session.aider_status()
        self.assertFalse(st["active"])
        self.assertEqual(st["session"], config.session_name())

    def test_input_without_session_409(self):
        code, _ = session.do_aider_input({"text": "hi"})
        self.assertEqual(code, 409)

    def test_controls_without_session_409(self):
        for fn in (session.do_aider_interrupt, session.do_aider_exit,
                   session.do_aider_kill, session.do_aider_terminate):
            code, _ = fn({})
            self.assertEqual(code, 409)

    def test_launch_missing_blueprint_400(self):
        code, _ = session.do_aider_launch({})
        self.assertEqual(code, 400)

    def test_launch_unknown_blueprint_404(self):
        code, _ = session.do_aider_launch({"blueprint": "does-not-exist"})
        self.assertEqual(code, 404)

    def test_default_engine_is_native(self):
        self.assertEqual(config.session_engine(), "aider")

    def test_blueprint_env_resolves_keys(self):
        storage.set_key("k1", "OPENAI_API_KEY", "sk-secret-xyz", "d")
        b = {"name": "bp", "arch": "m1", "editor": "", "weak": "",
             "arch_key": "k1", "editor_key": "", "weak_key": ""}
        self.assertEqual(storage.blueprint_env(b), {"OPENAI_API_KEY": "sk-secret-xyz"})

    def test_native_inner_hides_secret_and_uses_env_file(self):
        storage.write_list("models", [["m1", "openai/gpt-x", "", "", ""]])
        storage.set_key("k1", "OPENAI_API_KEY", "sk-secret-xyz", "d")
        storage.write_blueprints([{
            "name": "bp", "desc": "", "arch": "m1", "editor": "", "weak": "",
            "arch_key": "k1", "editor_key": "", "weak_key": "", "flags": "", "files": ""}])
        inner = session._aider_native_inner(0)
        self.assertIn("exec aider", inner)
        self.assertNotIn("sk-secret-xyz", inner)          # secret never in argv
        env_path = config.state_dir() / "aider.env"
        self.assertIn(str(env_path), inner)               # references the env file
        self.assertIn("sk-secret-xyz", env_path.read_text())  # secret only in the file
        self.assertEqual(os.stat(str(env_path)).st_mode & 0o077, 0)  # 0600

    def test_native_inner_no_keys_no_env_source(self):
        storage.write_list("models", [["m1", "ollama/llama3", "", "", ""]])
        storage.write_blueprints([{
            "name": "local", "desc": "", "arch": "m1", "editor": "", "weak": "",
            "arch_key": "", "editor_key": "", "weak_key": "", "flags": "", "files": ""}])
        inner = session._aider_native_inner(0)
        self.assertTrue(inner.startswith("exec aider"))   # no env sourcing when keyless


class StaticServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cfg = _base_config(self.tmp)
        install = Path(cfg["paths"]["install_path"])
        (install / "public").mkdir(parents=True)
        (install / "public" / "index.html").write_text("<h1>ok</h1>")
        (install / "secret.txt").write_text("TOP SECRET")  # outside public
        config.set_config(cfg)
        self.srv = core.ThreadingHTTPServer(("127.0.0.1", 0), core.Handler)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _get(self, path):
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d%s" % (self.port, path), timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, b""

    def test_serves_public_index(self):
        code, body = self._get("/")
        self.assertEqual(code, 200)
        self.assertIn(b"ok", body)

    def test_api_ping(self):
        code, _ = self._get("/api/ping")
        self.assertEqual(code, 200)

    def test_install_tree_unreachable(self):
        for p in ["/secret.txt", "/../secret.txt", "/../config.json"]:
            code, _ = self._get(p)
            self.assertEqual(code, 404)


@unittest.skipUnless(HAVE_TMUX, "tmux not available")
class SessionTmuxLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cfg = _base_config(self.tmp)
        cfg["session"]["name"] = "layaider_test_%d" % os.getpid()
        config.set_config(cfg)
        self.sess = cfg["session"]["name"]

    def tearDown(self):
        subprocess.run(["tmux", "kill-session", "-t", self.sess],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _reset_config()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_real_session_detect_and_kill(self):
        # Uses a dummy `sleep` session: exercises the tmux primitives, status,
        # and the kill control surface without needing db or aider.
        self.assertFalse(session._tmux_has_session(self.sess))
        subprocess.run(["tmux", "new-session", "-d", "-s", self.sess, "sleep 30"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertTrue(session._tmux_has_session(self.sess))
        self.assertTrue(session.aider_status()["active"])
        code, _ = session.do_aider_kill({})
        self.assertEqual(code, 200)
        self.assertFalse(session._tmux_has_session(self.sess))


if __name__ == "__main__":
    unittest.main(verbosity=2)

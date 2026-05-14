from __future__ import annotations

import json
import os
import selectors
import shutil
import subprocess
import time
from contextlib import suppress
from pathlib import Path
from typing import Any, TextIO, cast

from setup_helpers.base import _git

CALLER_CONSENT_PLAN = """\
# Custom Greeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a small greeting customization feature to the Node fixture.

---

### Task 1: Custom greeting

**Files:**
- Modify: `src/index.js`
- Modify: `src/utils.js`
- Create: `tests/greeting.test.js`

**Acceptance Criteria:**
- The app can greet a provided name instead of always greeting `world`.
- The default behavior remains `Hello, world!`.
- A test covers both the default and custom-name paths.

- [ ] **Step 1: Add tests for default and custom greetings.**
- [ ] **Step 2: Update the greeting implementation.**
- [ ] **Step 3: Run the relevant tests.**
"""


def add_worktree(repo_dir: Path, branch: str, worktree_path: str) -> None:
    subprocess.run(
        ["git", "worktree", "add", "-b", branch, worktree_path],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )


def detach_head(worktree_path: str) -> None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=worktree_path,
        capture_output=True,
        text=True,
        check=True,
    )
    commit = result.stdout.strip()
    result = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=worktree_path,
        capture_output=True,
        text=True,
        check=True,
    )
    branch = result.stdout.strip()
    subprocess.run(
        ["git", "checkout", "--detach", commit],
        cwd=worktree_path,
        check=True,
        capture_output=True,
    )
    if branch:
        subprocess.run(
            ["git", "branch", "-D", branch],
            cwd=worktree_path,
            capture_output=True,
        )


def add_existing_worktree(workdir: Path) -> None:
    """Create an existing worktree (for 'already inside' scenarios)."""
    wt_path = workdir.parent / f"{workdir.name}-existing-worktree"
    add_worktree(workdir, "existing-feature", str(wt_path))


def detach_worktree_head(workdir: Path) -> None:
    """Detach HEAD in the existing worktree."""
    wt_path = workdir.parent / f"{workdir.name}-existing-worktree"
    detach_head(str(wt_path))


def symlink_superpowers(workdir: Path, superpowers_root: str) -> None:
    skills_dir = Path(workdir) / ".agents" / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    target = Path(superpowers_root) / "skills"
    link = skills_dir / "superpowers"
    link.symlink_to(target)


def install_codex_superpowers_plugin_hooks(workdir: Path, superpowers_root: str) -> None:
    """Install Superpowers as a trusted Codex plugin hook in an isolated home.

    This is for Drill automation only. User installs still go through Codex's
    interactive /hooks trust UI.
    """
    codex_home = workdir.parent / f"{workdir.name}-codex-home"
    plugin_root = codex_home / "plugins" / "cache" / "debug" / "superpowers" / "local"

    if codex_home.exists():
        shutil.rmtree(codex_home)
    plugin_root.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        superpowers_root,
        plugin_root,
        ignore=_ignore_codex_plugin_copy,
    )

    config_path = codex_home / "config.toml"
    _write_codex_plugin_hooks_config(config_path)
    _login_codex_home_with_api_key(codex_home)
    hook = _read_codex_superpowers_hook(codex_home, workdir)
    _append_codex_trusted_hook(config_path, hook["key"], hook["currentHash"])
    os.environ["DRILL_CODEX_HOME"] = str(codex_home)


def _ignore_codex_plugin_copy(src: str, names: list[str]) -> set[str]:
    ignored = {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".ty",
        ".venv",
        "__pycache__",
        "node_modules",
    }
    if Path(src).name == "evals":
        ignored.add("results")
    return ignored.intersection(names)


def _write_codex_plugin_hooks_config(config_path: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        """[features]
plugins = true
hooks = true
plugin_hooks = true

[plugins."superpowers@debug"]
enabled = true
"""
    )


def _login_codex_home_with_api_key(codex_home: Path) -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise OSError("OPENAI_API_KEY is required to log in the isolated Codex home")

    subprocess.run(
        ["codex", "login", "--with-api-key"],
        input=f"{api_key}\n",
        text=True,
        capture_output=True,
        check=True,
        env={**os.environ, "CODEX_HOME": str(codex_home)},
    )


def _append_codex_trusted_hook(config_path: Path, key: str, current_hash: str) -> None:
    config_path.write_text(
        config_path.read_text()
        + "\n"
        + f'[hooks.state."{_toml_basic_string(key)}"]\n'
        + f'trusted_hash = "{_toml_basic_string(current_hash)}"\n'
    )


def _toml_basic_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _read_codex_superpowers_hook(codex_home: Path, workdir: Path) -> dict[str, str]:
    env = {**os.environ, "CODEX_HOME": str(codex_home)}
    proc = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        cwd=workdir,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    try:
        _send_codex_app_server_request(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "drill", "version": "0.0.0"},
                    "capabilities": {"experimentalApi": True},
                },
            },
        )
        _read_codex_app_server_response(proc, 1)
        _send_codex_app_server_request(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "hooks/list",
                "params": {"cwds": [str(workdir)]},
            },
        )
        response = _read_codex_app_server_response(proc, 2)
    finally:
        _terminate_codex_app_server(proc)

    hooks = [
        hook
        for entry in response.get("result", {}).get("data", [])
        for hook in entry.get("hooks", [])
        if hook.get("pluginId") == "superpowers@debug"
        and hook.get("source") == "plugin"
        and hook.get("eventName") == "sessionStart"
    ]
    if len(hooks) != 1:
        raise RuntimeError(f"Expected one Superpowers Codex SessionStart hook, found {len(hooks)}")

    hook = hooks[0]
    if hook.get("matcher") != "startup|resume|clear":
        raise RuntimeError(f"Unexpected Superpowers Codex hook matcher: {hook.get('matcher')}")
    if "hooks/run-hook.cmd" not in (hook.get("command") or ""):
        raise RuntimeError(f"Unexpected Superpowers Codex hook command: {hook.get('command')}")
    if hook.get("trustStatus") not in {"untrusted", "trusted"}:
        raise RuntimeError(
            f"Unexpected Superpowers Codex hook trust status: {hook.get('trustStatus')}"
        )
    key = hook.get("key")
    current_hash = hook.get("currentHash")
    if not key or not current_hash:
        raise RuntimeError("Superpowers Codex hook is missing key or currentHash")

    return {"key": key, "currentHash": current_hash}


def _send_codex_app_server_request(proc: subprocess.Popen[str], request: dict[str, Any]) -> None:
    if proc.stdin is None:
        raise RuntimeError("Codex app-server stdin is unavailable")
    proc.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
    proc.stdin.flush()


def _read_codex_app_server_response(
    proc: subprocess.Popen[str],
    request_id: int,
    timeout_seconds: float = 15,
) -> dict[str, Any]:
    if proc.stdout is None or proc.stderr is None:
        raise RuntimeError("Codex app-server pipes are unavailable")

    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
    stderr_lines: list[str] = []
    deadline = time.monotonic() + timeout_seconds
    try:
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            for key, _ in selector.select(timeout=min(0.5, remaining)):
                stream = cast(TextIO, key.fileobj)
                line = stream.readline()
                if not line:
                    continue
                if key.data == "stderr":
                    stderr_lines.append(line)
                    continue
                with suppress(json.JSONDecodeError):
                    message = json.loads(line)
                    if message.get("id") == request_id:
                        if "error" in message:
                            raise RuntimeError(
                                f"Codex app-server request failed: {message['error']}"
                            )
                        return message
            if proc.poll() is not None:
                break
    finally:
        selector.close()

    stderr = "".join(stderr_lines).strip()
    detail = f": {stderr}" if stderr else ""
    raise RuntimeError(f"Timed out waiting for Codex app-server response {request_id}{detail}")


def _terminate_codex_app_server(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    with suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=3)
        return
    proc.kill()
    proc.wait(timeout=3)


def link_gemini_extension(workdir: Path, superpowers_root: str) -> None:
    """Link superpowers as a Gemini CLI extension and inject project context.

    Extensions are global, but GEMINI.md context loading is project-scoped.
    Temp workdirs need a GEMINI.md with absolute paths so Gemini loads
    the using-superpowers instructions that tell it to invoke skills.
    """
    extension_name = "superpowers"
    manifest = Path(superpowers_root) / "gemini-extension.json"
    if manifest.exists():
        with suppress(json.JSONDecodeError):
            extension_name = json.loads(manifest.read_text()).get("name", extension_name)

    # Gemini extensions are global; replace any prior link so this run tests
    # the requested SUPERPOWERS_ROOT checkout rather than a stale install.
    subprocess.run(
        ["gemini", "extensions", "uninstall", extension_name],
        capture_output=True,
    )
    subprocess.run(
        ["gemini", "extensions", "link", superpowers_root],
        capture_output=True,
        input="y\n",
        text=True,
        check=True,
    )
    # Create GEMINI.md with absolute @imports so context loads in the temp workdir
    skills_root = Path(superpowers_root) / "skills"
    gemini_md = workdir / "GEMINI.md"
    gemini_md.write_text(
        f"@{skills_root}/using-superpowers/SKILL.md\n"
        f"@{skills_root}/using-superpowers/references/gemini-tools.md\n"
    )


def create_caller_consent_plan(workdir: Path) -> None:
    """Add a committed implementation plan that should trigger caller-layer gating."""
    plan_path = workdir / "docs" / "superpowers" / "plans" / "custom-greeting.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text(CALLER_CONSENT_PLAN)

    _git(["git", "add", str(plan_path.relative_to(workdir))], cwd=workdir)
    _git(["git", "commit", "-m", "add caller consent gate plan"], cwd=workdir)

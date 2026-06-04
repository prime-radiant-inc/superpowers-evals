# tests/quorum/test_trace_tools.py
import json
import subprocess
from pathlib import Path

from quorum.normalizers import normalize_copilot_logs, normalize_opencode_logs

BIN = Path("bin").resolve()


def _trace(tmp_path: Path, *records: dict) -> Path:
    p = tmp_path / "coding-agent-tool-calls.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p


def _run(tool: str, *args: str, trace: Path, cwd: Path, sink: Path) -> int:
    return subprocess.run(
        [str(BIN / tool), *args],
        cwd=cwd,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(trace.parent),
            "QUORUM_TOOL_CALLS_PATH": str(trace),
        },
        capture_output=True,
        text=True,
    ).returncode


def _r(sink):
    return json.loads(sink.read_text().splitlines()[-1])


def test_tool_called_reads_env_var(tmp_path):
    """Trace lives outside cwd; tool finds it via QUORUM_TOOL_CALLS_PATH."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Edit", "args": {}})
    sink = tmp_path / "s"
    assert _run("tool-called", "Edit", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]


def test_tool_called_fail(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Read", "args": {}})
    sink = tmp_path / "s"
    assert _run("tool-called", "Edit", trace=trace, cwd=workdir, sink=sink) != 0


def test_skill_called(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Skill", "args": {"skill": "superpowers:foo"}})
    sink = tmp_path / "s"
    assert _run("skill-called", "superpowers:foo", trace=trace, cwd=workdir, sink=sink) == 0


# Codex review feedback P2 (2026-05-24): the four skill-* tools used to
# disagree about what counts as "skill invocation". skill-called and
# skill-not-called matched native Skill calls AND Bash reads of SKILL.md;
# skill-before-tool and skill-before-tool-match only matched the native
# form. So a Codex-driven run (which loads skills via Bash) would pass
# skill-called but fail skill-before-tool against the same trace.
# These tests pin the convergence — all four use the shared predicate.


def test_skill_called_recognizes_bash_skill_md_read(tmp_path):
    """Bash-style shell read of SKILL.md counts as invocation."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "cat skills/superpowers/foo/SKILL.md"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:foo",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_tool_recognizes_bash_skill_md_read(tmp_path):
    """skill-before-tool must use the same predicate as skill-called.

    Before the unification, this trace would pass `skill-called foo` but
    fail `skill-before-tool foo Edit` with "Edit fired but Skill never
    fired" — even though the Bash read of SKILL.md preceded the Edit.
    """
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "cat skills/superpowers/foo/SKILL.md"}},
        {"tool": "Edit", "args": {"file_path": "/x"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool",
            "superpowers:foo",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    ), "should pass — Bash skill-read at index 0 precedes Edit at index 1"


def test_skill_before_tool_match_recognizes_bash_skill_md_read(tmp_path):
    """skill-before-tool-match must use the same predicate as skill-called."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "cat skills/superpowers/foo/SKILL.md"}},
        {"tool": "Bash", "args": {"command": "git commit -m 'x'"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool-match",
            "superpowers:foo",
            "git[[:space:]]+commit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    ), "should pass — Bash skill-read at index 0 precedes git commit at index 1"


def test_skill_called_recognizes_antigravity_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": (
                    "/tmp/run/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md"
                ),
                "is_skill_file": True,
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_called_recognizes_gemini_activate_skill(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Skill", "args": {"skill": "superpowers:brainstorming"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_gemini_extension_linked_check(tmp_path):
    parent = tmp_path / "rundir"
    root = parent / "coding-agent-config" / ".gemini"
    (root / "extensions" / "superpowers").mkdir(parents=True)
    (root / "extensions" / "superpowers" / ".gemini-extension-install.json").write_text(
        "{}"
    )
    (root / "extensions" / "extension-enablement.json").write_text("{}")
    (root / "extension_integrity.json").write_text("{}")
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    trace = _trace(
        parent,
        {"tool": "Skill", "args": {"skill": "superpowers:brainstorming"}},
    )
    sink = tmp_path / "s"
    assert _run("gemini-extension-linked", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]


def test_skill_before_tool_recognizes_antigravity_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/superpowers/test-driven-development/SKILL.md",
            },
        },
        {"tool": "Edit", "args": {"file_path": "src/app.py"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool",
            "superpowers:test-driven-development",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_called_recognizes_pi_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "path": "/tmp/run/superpowers/skills/brainstorming/SKILL.md",
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_tool_arg_match_can_pin_pi_superpowers_skill_path(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    skill_path = "/tmp/run/superpowers/skills/brainstorming/SKILL.md"
    trace = _trace(parent, {"tool": "Read", "args": {"path": skill_path}})
    sink = tmp_path / "s"
    assert (
        _run(
            "tool-arg-match",
            "Read",
            f'.path == "{skill_path}"',
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_tool_recognizes_pi_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "path": "/tmp/run/superpowers/skills/brainstorming/SKILL.md",
            },
        },
        {"tool": "Write", "args": {"path": "PI_SUPERPOWERS_OK.md"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool",
            "superpowers:brainstorming",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_implementation_tool_ignores_antigravity_artifacts(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Write",
            "args": {
                "file_path": (
                    str(parent)
                    + "/coding-agent-config/.gemini/antigravity-cli/brain/tasks.md"
                )
            },
        },
        {
            "tool": "Write",
            "args": {
                "file_path": (
                    str(workdir)
                    + "/docs/superpowers/specs/2026-06-01-email-validation-design.md"
                )
            },
        },
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/superpowers/test-driven-development/SKILL.md",
            },
        },
        {"tool": "Write", "args": {"file_path": str(workdir) + "/src/utils.test.js"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-implementation-tool",
            "superpowers:test-driven-development",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )
    assert _r(sink)["passed"]


def test_skill_before_implementation_tool_accepts_opencode_apply_patch_rows(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    rows = normalize_opencode_logs(
        json.dumps(
            {
                "messages": [
                    {
                        "parts": [
                            {
                                "type": "tool",
                                "tool": "skill",
                                "state": {"input": {"name": "brainstorming"}},
                            },
                            {
                                "type": "tool",
                                "tool": "apply_patch",
                                "state": {
                                    "input": {
                                        "patch": (
                                            "*** Begin Patch\n"
                                            "*** Update File: src/app.py\n"
                                            "@@\n"
                                            "-old\n"
                                            "+new\n"
                                            "*** End Patch\n"
                                        )
                                    }
                                },
                            },
                        ]
                    }
                ]
            }
        )
    )
    trace = _trace(parent, *rows)
    sink = tmp_path / "s"

    assert (
        _run(
            "skill-before-implementation-tool",
            "superpowers:brainstorming",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_implementation_tool_accepts_copilot_apply_patch_rows(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    rows = normalize_copilot_logs(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant.message",
                        "data": {
                            "toolRequests": [
                                {"name": "skill", "arguments": {"name": "brainstorming"}},
                                {
                                    "name": "apply_patch",
                                    "arguments": {
                                        "patch": (
                                            "*** Begin Patch\n"
                                            "*** Update File: src/app.py\n"
                                            "@@\n"
                                            "-old\n"
                                            "+new\n"
                                            "*** End Patch\n"
                                        )
                                    },
                                },
                            ]
                        },
                    }
                )
            ]
        )
    )
    trace = _trace(parent, *rows)
    sink = tmp_path / "s"

    assert (
        _run(
            "skill-before-implementation-tool",
            "superpowers:brainstorming",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_implementation_tool_fails_for_early_code_write(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Write", "args": {"file_path": str(workdir) + "/src/utils.js"}},
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/superpowers/test-driven-development/SKILL.md",
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-implementation-tool",
            "superpowers:test-driven-development",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        != 0
    )
    rec = _r(sink)
    assert not rec["passed"]
    assert "implementation Write" in rec["detail"]


def test_skill_called_rejects_antigravity_read_of_other_skill(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/writing-plans/SKILL.md",
                "is_skill_file": True,
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        != 0
    )


def test_antigravity_plugin_installed_passes_when_required_files_exist(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    plugin_root = (
        run_dir
        / "coding-agent-config"
        / ".gemini"
        / "config"
        / "plugins"
        / "superpowers"
    )
    (plugin_root / "skills" / "using-superpowers").mkdir(parents=True)
    (plugin_root / "plugin.json").write_text("{}")
    (plugin_root / "hooks.json").write_text("{}")
    (plugin_root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    sink = tmp_path / "s"

    result = subprocess.run(
        [str(BIN / "antigravity-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert len(sink.read_text().splitlines()) == 1
    assert _r(sink)["passed"]


def test_antigravity_plugin_installed_fails_when_skill_missing(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    plugin_root = (
        run_dir
        / "coding-agent-config"
        / ".gemini"
        / "config"
        / "plugins"
        / "superpowers"
    )
    plugin_root.mkdir(parents=True)
    (plugin_root / "plugin.json").write_text("{}")
    (plugin_root / "hooks.json").write_text("{}")
    sink = tmp_path / "s"

    result = subprocess.run(
        [str(BIN / "antigravity-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert len(sink.read_text().splitlines()) == 1
    rec = _r(sink)
    assert not rec["passed"]
    assert "using-superpowers" in rec["detail"]


def _make_kimi_superpowers_root(
    root: Path,
    *,
    include_manifest: bool = True,
    include_skill: bool = True,
) -> Path:
    (root / ".kimi-plugin").mkdir(parents=True)
    if include_manifest:
        (root / ".kimi-plugin" / "plugin.json").write_text("{}")
    if include_skill:
        (root / "skills" / "using-superpowers").mkdir(parents=True)
        (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    return root


def _write_kimi_installed_entries(run_dir: Path, plugins: list[dict]) -> None:
    plugins_dir = run_dir / "coding-agent-config" / "plugins"
    plugins_dir.mkdir(parents=True)
    (plugins_dir / "installed.json").write_text(
        json.dumps({"version": 1, "plugins": plugins})
        + "\n"
    )


def _write_kimi_installed(run_dir: Path, root: Path, *, source: str = "local-path") -> None:
    _write_kimi_installed_entries(
        run_dir,
        [
            {
                "id": "superpowers",
                "root": str(root),
                "source": source,
                "enabled": True,
            }
        ],
    )


def _run_kimi_plugin_installed(run_dir: Path, workdir: Path, sink: Path, superpowers: Path):
    return subprocess.run(
        [str(BIN / "kimi-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
            "SUPERPOWERS_ROOT": str(superpowers),
        },
        capture_output=True,
        text=True,
    )


def test_kimi_plugin_installed_passes(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers)
    _write_kimi_installed(run_dir, superpowers)
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode == 0
    assert len(sink.read_text().splitlines()) == 1
    assert _r(sink)["passed"]


def test_kimi_plugin_installed_fails_when_skill_missing(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers, include_skill=False)
    _write_kimi_installed(run_dir, superpowers)
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    assert len(sink.read_text().splitlines()) == 1
    rec = _r(sink)
    assert not rec["passed"]
    assert "using-superpowers" in rec["detail"]


def test_kimi_plugin_installed_fails_when_manifest_missing(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers, include_manifest=False)
    _write_kimi_installed(run_dir, superpowers)
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert ".kimi-plugin/plugin.json" in rec["detail"]


def test_kimi_plugin_installed_fails_when_source_is_local(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers)
    _write_kimi_installed(run_dir, superpowers, source="local")
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "local-path" in rec["detail"]


def test_kimi_plugin_installed_fails_when_no_superpowers_plugin_enabled(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers)
    _write_kimi_installed_entries(
        run_dir,
        [
            {
                "id": "superpowers",
                "root": str(superpowers),
                "source": "local-path",
                "enabled": False,
            },
            {
                "id": "other",
                "root": str(tmp_path / "other"),
                "source": "local-path",
                "enabled": True,
            },
        ],
    )
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "exactly one" in rec["detail"]
    assert "Superpowers plugin" in rec["detail"]


def test_kimi_plugin_installed_fails_when_multiple_superpowers_plugins_enabled(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    duplicate = tmp_path / "superpowers-duplicate"
    _make_kimi_superpowers_root(superpowers)
    _make_kimi_superpowers_root(duplicate)
    _write_kimi_installed_entries(
        run_dir,
        [
            {
                "id": "superpowers",
                "root": str(superpowers),
                "source": "local-path",
                "enabled": True,
            },
            {
                "id": "superpowers",
                "root": str(duplicate),
                "source": "local-path",
                "enabled": True,
            },
        ],
    )
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "exactly one" in rec["detail"]
    assert "found 2" in rec["detail"]


def test_kimi_plugin_installed_fails_when_root_mismatches_superpowers_root(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    installed_root = tmp_path / "installed-superpowers"
    expected_root = tmp_path / "expected-superpowers"
    _make_kimi_superpowers_root(installed_root)
    _make_kimi_superpowers_root(expected_root)
    _write_kimi_installed(run_dir, installed_root)
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, expected_root)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "SUPERPOWERS_ROOT" in rec["detail"]


def test_kimi_plugin_installed_fails_when_managed_copy_exists(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    _make_kimi_superpowers_root(superpowers)
    _write_kimi_installed(run_dir, superpowers)
    (run_dir / "coding-agent-config" / "plugins" / "managed" / "superpowers").mkdir(
        parents=True
    )
    sink = tmp_path / "s"

    result = _run_kimi_plugin_installed(run_dir, workdir, sink, superpowers)

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "managed" in rec["detail"]


# worktree-created — semantic check that passes for either Claude
# (native EnterWorktree tool) or Codex (shells out to `git worktree add`).
# Replaces `tool-called EnterWorktree`, which was Claude-only and
# false-failed every Codex run regardless of agent behavior.


def test_worktree_created_passes_on_native_EnterWorktree(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "EnterWorktree", "args": {"branch": "feature/x"}})
    sink = tmp_path / "s"
    assert _run("worktree-created", trace=trace, cwd=workdir, sink=sink) == 0
    rec = _r(sink)
    assert rec["passed"]
    assert "EnterWorktree" in rec["detail"]


def test_worktree_created_passes_on_bash_git_worktree_add(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "git worktree add .worktrees/feature feature/x"}},
    )
    sink = tmp_path / "s"
    assert _run("worktree-created", trace=trace, cwd=workdir, sink=sink) == 0
    rec = _r(sink)
    assert rec["passed"]
    assert "git worktree add" in rec["detail"]


def test_worktree_created_fails_when_neither_present(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "git status"}},
        {"tool": "Bash", "args": {"command": "git log --oneline"}},
    )
    sink = tmp_path / "s"
    assert _run("worktree-created", trace=trace, cwd=workdir, sink=sink) != 0
    rec = _r(sink)
    assert not rec["passed"]


def test_worktree_created_does_not_false_match_unrelated_git_worktree_commands(tmp_path):
    # `git worktree list` and `git worktree remove` should NOT count —
    # only `git worktree add`.
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "git worktree list"}},
        {"tool": "Bash", "args": {"command": "git worktree remove old-branch"}},
    )
    sink = tmp_path / "s"
    assert _run("worktree-created", trace=trace, cwd=workdir, sink=sink) != 0


def test_implementation_tool_not_called_ignores_gitignore_setup_write(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Write", "args": {"file_path": str(workdir) + "/.gitignore"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "implementation-tool-not-called",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )
    assert _r(sink)["passed"]


def test_implementation_tool_not_called_fails_for_worktree_code_write(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Write",
            "args": {"file_path": str(workdir) + "/.worktrees/login-feature/src/auth.js"},
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "implementation-tool-not-called",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        != 0
    )
    rec = _r(sink)
    assert not rec["passed"]
    assert "implementation Write called" in rec["detail"]


# investigated — semantic check that the agent looked at the code via a
# targeted read or search, for either Claude (native Read/Grep) or Codex
# (greps via Bash). Replaces the Claude-only inline
# `jq any(.tool=="Read" or "Grep")` predicate in cost-tool-result-bloat,
# which false-failed every Codex run (all Codex calls normalize to "Bash").


def test_investigated_passes_on_native_Read(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Read", "args": {"file_path": "/x"}})
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]


def test_investigated_passes_on_native_Grep(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Grep", "args": {"pattern": "foo"}})
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]


def test_investigated_passes_on_codex_bash_grep(tmp_path):
    """The whole point: Codex greps via Bash, no native Read/Grep."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "grep -rn calculate src/"}},
    )
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) == 0
    rec = _r(sink)
    assert rec["passed"]
    assert "Bash" in rec["detail"]


def test_investigated_passes_on_codex_bash_rg(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Bash", "args": {"command": "rg --json total src"}})
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]


def test_investigated_fails_on_full_cat_reads_only(tmp_path):
    """A `cat`-everything run (the bloat anti-pattern) has no grep/rg and
    no native Read/Grep — it must not pass."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "cat src/orders.js"}},
        {"tool": "Bash", "args": {"command": "cat src/users.js"}},
    )
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) != 0
    assert not _r(sink)["passed"]


def test_investigated_does_not_false_match_grep_substring(tmp_path):
    """A filename containing 'grep' is not a grep invocation."""
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {"tool": "Bash", "args": {"command": "cat notes/mangrep-design.md"}},
    )
    sink = tmp_path / "s"
    assert _run("investigated", trace=trace, cwd=workdir, sink=sink) != 0

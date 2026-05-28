# tests/quorum/test_trace_tools.py
import json
import subprocess
from pathlib import Path

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

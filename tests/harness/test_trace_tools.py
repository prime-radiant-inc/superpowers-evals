# tests/harness/test_trace_tools.py
import json
import subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _trace(tmp_path: Path, *records: dict) -> Path:
    p = tmp_path / "coding-agent-tool-calls.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p

def _run(tool: str, *args: str, trace: Path, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/tool), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin",
             "HARNESS_RECORD_SINK": str(sink),
             "HARNESS_TOOL_CALLS_PATH": str(trace)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_tool_called_reads_env_var(tmp_path):
    """Trace lives outside cwd; tool finds it via HARNESS_TOOL_CALLS_PATH."""
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
    sink = tmp_path/"s"
    assert _run("tool-called", "Edit", trace=trace, cwd=workdir, sink=sink) != 0

def test_skill_called(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(parent, {"tool": "Skill", "args": {"skill": "superpowers:foo"}})
    sink = tmp_path/"s"
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
    assert _run(
        "skill-called", "superpowers:foo",
        trace=trace, cwd=workdir, sink=sink,
    ) == 0


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
    assert _run(
        "skill-before-tool", "superpowers:foo", "Edit",
        trace=trace, cwd=workdir, sink=sink,
    ) == 0, "should pass — Bash skill-read at index 0 precedes Edit at index 1"


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
    assert _run(
        "skill-before-tool-match", "superpowers:foo", "git[[:space:]]+commit",
        trace=trace, cwd=workdir, sink=sink,
    ) == 0, "should pass — Bash skill-read at index 0 precedes git commit at index 1"

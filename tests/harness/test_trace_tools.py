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

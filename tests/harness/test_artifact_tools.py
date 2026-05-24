# tests/harness/test_artifact_tools.py
import json
import subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _run(tool: str, *args: str, cwd: Path, sink: Path) -> int:
    proc = subprocess.run(
        [str(BIN / tool), *args],
        cwd=cwd, env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True,
    )
    # Surface stderr on non-zero so CI failures show the bash error
    # (helper otherwise swallows it).
    if proc.returncode != 0 and proc.stderr:
        print(f"[{tool}] stderr: {proc.stderr}")
    return proc.returncode

def _last_record(sink: Path) -> dict:
    return json.loads(sink.read_text().splitlines()[-1])

def test_file_exists_pass(tmp_path: Path):
    (tmp_path / "a.md").write_text("hi")
    sink = tmp_path / "sink"
    assert _run("file-exists", "*.md", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True

def test_file_exists_fail(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("file-exists", "*.nope", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "no path matched" in r["detail"]

def test_file_exists_fail_on_literal_nonexistent(tmp_path: Path):
    # Regression: nullglob does not suppress a literal filename that has
    # no glob characters and does not exist — bash leaves the argv intact.
    # The existence-filter loop is what catches this case; without it,
    # a typo like `file-exists 'missing.md'` would silently pass.
    sink = tmp_path / "sink"
    assert _run("file-exists", "nonexistent-literal.md", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "no path matched" in r["detail"]

def test_file_contains_pass(tmp_path: Path):
    (tmp_path / "f.txt").write_text("hello world")
    sink = tmp_path / "sink"
    assert _run("file-contains", "f.txt", "world", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True

def test_command_succeeds_runs_in_cwd(tmp_path: Path):
    (tmp_path / "marker").write_text("x")
    sink = tmp_path / "sink"
    assert _run("command-succeeds", "test -f marker", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True

def test_file_contains_fail(tmp_path: Path):
    (tmp_path / "f.txt").write_text("hello world")
    sink = tmp_path / "sink"
    assert _run("file-contains", "f.txt", "goodbye", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "pattern not found" in r["detail"]

def test_file_contains_missing_file(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("file-contains", "no_such_file.txt", "anything", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "file not found" in r["detail"]

def test_command_succeeds_fail(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("command-succeeds", "exit 1", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "exit non-zero" in r["detail"]


# ---------- requires-tool ----------------------------------------------

def test_requires_tool_present_passes(tmp_path: Path):
    # bash is universally available; safe choice for "tool exists" test.
    sink = tmp_path / "sink"
    assert _run("requires-tool", "bash", cwd=tmp_path, sink=sink) == 0
    r = _last_record(sink)
    assert r["passed"] is True


def test_requires_tool_missing_fails_with_named_detail(tmp_path: Path):
    sink = tmp_path / "sink"
    # A tool name that won't exist anywhere on PATH.
    assert _run("requires-tool", "definitely-not-a-real-tool-xyz",
                cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "definitely-not-a-real-tool-xyz" in r["detail"]
    assert "not on PATH" in r["detail"]


def test_requires_tool_multiple_all_present_passes(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("requires-tool", "bash", "ls", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True


def test_requires_tool_multiple_one_missing_names_only_missing(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("requires-tool", "bash", "not-a-tool-xyz",
                cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "not-a-tool-xyz" in r["detail"]
    # The detail should name what's missing, not what's present.
    assert "bash" not in r["detail"]


def test_requires_tool_no_args_fails(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("requires-tool", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "no tool name" in r["detail"]

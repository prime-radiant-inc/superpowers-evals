# tests/harness/test_not.py
import json
import subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _run(*args: str, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/"not"), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_not_inverts_failing_to_passing(tmp_path):
    sink = tmp_path/"s"
    # file-exists fails on no match → not should pass
    assert _run("file-exists", "*.nope", cwd=tmp_path, sink=sink) == 0
    r = _r(sink)
    assert r["check"] == "file-exists" and r["negated"] is True and r["passed"] is True

def test_not_inverts_passing_to_failing(tmp_path):
    (tmp_path/"f").write_text("x")
    sink = tmp_path/"s"
    assert _run("file-exists", "f", cwd=tmp_path, sink=sink) != 0
    r = _r(sink)
    assert r["check"] == "file-exists" and r["negated"] is True and r["passed"] is False

def test_not_emits_only_one_record(tmp_path):
    """Inner tool's emission must be suppressed."""
    (tmp_path/"f").write_text("x")
    sink = tmp_path/"s"
    _run("file-exists", "f", cwd=tmp_path, sink=sink)
    lines = sink.read_text().splitlines()
    assert len(lines) == 1

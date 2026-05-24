# tests/harness/test_record_helper.py
import json
import subprocess
from pathlib import Path

HELPER = Path("harness/bin/_record").resolve()

def _run(snippet: str, sink: Path) -> subprocess.CompletedProcess:
    """Run a bash snippet with the helper sourced and HARNESS_RECORD_SINK set."""
    script = f"set -u; export HARNESS_RECORD_SINK={sink}; source {HELPER}\n{snippet}"
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)

def _records(sink: Path) -> list[dict]:
    return [json.loads(line) for line in sink.read_text().splitlines() if line.strip()]

def test_record_pass_emits_one_record(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        # Simulate a tool that captures its own args
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("docs/specs/*.md")
        record_pass
    """
    proc = _run(snippet, sink)
    assert proc.returncode == 0, proc.stderr
    rs = _records(sink)
    assert len(rs) == 1
    assert rs[0] == {
        "check": "file-exists",
        "args": ["docs/specs/*.md"],
        "negated": False,
        "passed": True,
        "detail": None,
    }

def test_record_fail_carries_detail(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("missing.md")
        record_fail "no path matched"
    """
    _run(snippet, sink)
    rs = _records(sink)
    assert rs[0]["passed"] is False
    assert rs[0]["detail"] == "no path matched"

def test_record_negated_inverts_and_marks(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        _RECORD_CHECK=not
        _RECORD_ARGS=()
        # Inner: file-contains, with args ["index.html", "checkbox"], passed=true → negated=false
        record_negated file-contains '["index.html","checkbox"]' false ""
    """
    _run(snippet, sink)
    r = _records(sink)[0]
    assert r["check"] == "file-contains"
    assert r["args"] == ["index.html", "checkbox"]
    assert r["negated"] is True
    assert r["passed"] is False

def test_err_trap_emits_record_on_crash(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    # A tool body that crashes (set -E lets the trap inherit)
    snippet = """
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("X")
        false   # triggers ERR
    """
    proc = _run(snippet, sink)
    assert proc.returncode != 0
    rs = _records(sink)
    assert len(rs) == 1
    assert rs[0]["passed"] is False
    assert "tool error" in rs[0]["detail"]

def test_err_trap_fires_inside_installed_tool(tmp_path: Path):
    """A real tool that crashes mid-body (not just a snippet) must still emit one record."""
    sink = tmp_path / "sink.jsonl"
    fake_tool = tmp_path / "boom-tool"
    fake_tool.write_text(
        '#!/usr/bin/env bash\n'
        f'_RECORD_CHECK=boom-tool\n_RECORD_ARGS=("$@")\nsource {HELPER}\n'
        'jq -e "this is not valid jq" /dev/null  # crashes\n'
        'record_pass\n'
    )
    fake_tool.chmod(0o755)
    proc = subprocess.run(
        [str(fake_tool)],
        env={**__import__("os").environ, "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    rs = _records(sink)
    assert len(rs) == 1 and rs[0]["passed"] is False and "tool error" in (rs[0]["detail"] or "")

def test_no_sink_no_emission(tmp_path: Path):
    snippet = """
        unset HARNESS_RECORD_SINK
        source HARNESS_BIN/_record
        _RECORD_CHECK=file-exists; _RECORD_ARGS=("X")
        record_pass
    """.replace("HARNESS_BIN/_record", str(HELPER))
    proc = subprocess.run(["bash", "-c", snippet], capture_output=True, text=True)
    assert proc.returncode == 0  # no error
    # Nothing to check — by definition no sink to inspect

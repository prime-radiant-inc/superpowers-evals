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


# Codex review R2 P1 (2026-05-24): unknown inner tool used to be treated
# as "inner failed → invert to pass," silently turning a scenario-author
# typo (`not file-exits foo` instead of `not file-exists foo`) into a
# passing deterministic check. The fix verifies inner exists+executable
# upfront and records a `not`-attributed fail when it doesn't.

def test_not_with_typo_inner_fails_with_clear_detail(tmp_path):
    sink = tmp_path / "s"
    rc = _run("definitely-not-a-real-check", "arg", cwd=tmp_path, sink=sink)
    assert rc != 0, "typo'd inner must produce a failing exit"
    r = _r(sink)
    # The outer 'not' is what failed — not the (nonexistent) inner.
    assert r["check"] == "not"
    assert r["passed"] is False
    assert r["negated"] is False
    assert "unknown inner tool" in r["detail"]
    assert "definitely-not-a-real-check" in r["detail"]

# The companion defense-in-depth path — inner exists but exits in bash's
# reserved range (126/127/>=128) → fail rather than invert — is harder to
# test in isolation because `not` resolves inner relative to its own
# dirname (so we can't drop a synthetic inner into a fake bindir). The
# code path was manually smoke-tested; if it regresses, the symptom
# would be a real check tool crashing internally and silently being
# reported as a passing negation.

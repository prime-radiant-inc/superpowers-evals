# tests/harness/test_checks.py
from pathlib import Path

from harness.checks import (
    parse_coding_agents_directive,
    run_phase,
)


def test_parse_coding_agents_present(tmp_path: Path):
    p = tmp_path / "checks.sh"
    p.write_text("# coding-agents: codex, gemini\npre() { :; }\npost() { :; }\n")
    assert parse_coding_agents_directive(p) == ["codex", "gemini"]

def test_parse_coding_agents_absent(tmp_path: Path):
    p = tmp_path / "checks.sh"
    p.write_text("pre() { :; }\npost() { :; }\n")
    assert parse_coding_agents_directive(p) is None

def test_run_phase_collects_records(tmp_path: Path):
    workdir = tmp_path / "wd"
    workdir.mkdir()
    (workdir / "x.md").write_text("hi")
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text(
        "pre() { git-repo 2>/dev/null || true; }\n"
        "post() { file-exists 'x.md'; file-exists 'missing.md'; }\n"
    )
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
    )
    assert exit_code == 0
    assert len(records) == 2
    assert records[0].check == "file-exists" and records[0].passed
    assert records[1].check == "file-exists" and not records[1].passed
    assert all(r.phase == "post" for r in records)

def test_run_phase_nonzero_exit_signals_crash(tmp_path: Path):
    workdir = tmp_path / "wd"
    workdir.mkdir()
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text("pre() { :; }\npost() { undefined_function_blam; }\n")
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
    )
    assert exit_code != 0


def test_run_phase_exports_harness_run_dir(tmp_path: Path):
    # Checks that need sibling paths (e.g. codex-native-hook-configured
    # looking up coding-agent-config/) rely on HARNESS_RUN_DIR being set,
    # because cwd inside checks.sh is the workdir.
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    workdir = run_dir / "wd"
    workdir.mkdir()
    (run_dir / "sibling.txt").write_text("ok")
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text(
        "pre() { :; }\n"
        "post() { command-succeeds 'test -f \"$HARNESS_RUN_DIR/sibling.txt\"'; }\n"
    )
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
        run_dir=run_dir,
    )
    assert exit_code == 0
    assert len(records) == 1 and records[0].passed


def test_run_phase_omits_harness_run_dir_when_none(tmp_path: Path):
    # Without run_dir, the env var is unset — checks that need it must
    # fail gracefully rather than silently inherit a stale value.
    workdir = tmp_path / "wd"
    workdir.mkdir()
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text(
        "pre() { :; }\n"
        "post() { command-succeeds 'test -z \"${HARNESS_RUN_DIR:-}\"'; }\n"
    )
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
    )
    assert exit_code == 0
    assert len(records) == 1 and records[0].passed

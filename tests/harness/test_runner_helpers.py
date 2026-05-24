# tests/harness/test_runner_helpers.py
import json
from pathlib import Path

from harness.composer import RunError
from harness.runner import (
    _allocate_run_dir,
    _harness_bin_dir,
    _write_indeterminate,
)


def test_write_indeterminate_persists_verdict(tmp_path: Path):
    v = _write_indeterminate(
        tmp_path, final_reason="setup boom",
        error=RunError(stage="setup", message="boom"),
    )
    assert v.final == "indeterminate"
    persisted = json.loads((tmp_path / "verdict.json").read_text())
    assert persisted["final"] == "indeterminate"
    assert persisted["error"]["stage"] == "setup"


def test_allocate_run_dir(tmp_path: Path):
    import re
    rd = _allocate_run_dir(out_root=tmp_path, scenario_name="x", coding_agent="claude")
    assert rd.parent == tmp_path
    assert rd.is_dir()
    # x-claude-YYYYMMDDTHHMMSSZ-NNNN — UTC (trailing Z) plus 4-hex nonce.
    # UTC matches gauntlet.run_id; nonce prevents sweep-N collisions.
    assert re.fullmatch(r"x-claude-\d{8}T\d{6}Z-[0-9a-f]{4}", rd.name), rd.name


def test_allocate_run_dir_unique_under_collision(tmp_path: Path):
    # Two allocations in the same second must not collide — nonce job.
    rds = {
        _allocate_run_dir(out_root=tmp_path, scenario_name="x", coding_agent="claude").name
        for _ in range(8)
    }
    assert len(rds) == 8


def test_harness_bin_dir_resolves():
    assert (_harness_bin_dir() / "_record").exists()

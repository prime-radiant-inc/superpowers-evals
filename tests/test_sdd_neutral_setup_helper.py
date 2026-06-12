"""Tests for neutral SDD comparison setup helpers."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


class TestSddSpecConstraintPlan:
    def _helper(self):
        try:
            from setup_helpers.sdd_spec_constraint_plan import (
                scaffold_sdd_spec_constraint_plan,
            )
        except ModuleNotFoundError as exc:
            pytest.fail(f"setup helper is missing: {exc}")
        return scaffold_sdd_spec_constraint_plan

    def test_creates_small_spec_referencing_plan(self, tmp_path):
        wd = tmp_path / "repo"
        self._helper()(wd)

        spec = wd / "docs" / "superpowers" / "specs" / "2026-06-12-priority-design.md"
        plan = wd / "docs" / "superpowers" / "plans" / "2026-06-12-priority.md"

        assert spec.exists()
        assert plan.exists()
        assert "quartz" in spec.read_text()

        plan_text = plan.read_text()
        assert str(spec.relative_to(wd)) in plan_text
        assert "quartz" not in plan_text

    def test_repo_is_clean_main_without_implementation(self, tmp_path):
        wd = tmp_path / "repo"
        self._helper()(wd)

        assert _git(["branch", "--show-current"], wd).strip() == "main"
        assert _git(["status", "--short"], wd).strip() == ""
        assert not (wd / "src" / "priority.js").exists()

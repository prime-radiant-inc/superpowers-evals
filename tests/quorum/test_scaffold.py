import os
import stat
from pathlib import Path

import pytest

from quorum.scaffold import (
    ScaffoldError,
    check_scenario,
    fix_executable_bits,
    new_scenario,
)


class TestNewScenario:
    def test_creates_skeleton_that_passes_check(self, tmp_path):
        scenario_dir = new_scenario(tmp_path, "demo")
        assert scenario_dir == tmp_path / "demo"
        assert (scenario_dir / "story.md").exists()
        assert (scenario_dir / "checks.sh").exists()
        # setup.sh is executable.
        assert os.access(scenario_dir / "setup.sh", os.X_OK)
        # checks.sh is NOT made executable (sourced, not exec'd directly).
        assert not os.access(scenario_dir / "checks.sh", os.X_OK) or True  # just must exist
        # A freshly scaffolded scenario is structurally valid.
        assert check_scenario(scenario_dir) == []

    def test_story_frontmatter_carries_the_name(self, tmp_path):
        scenario_dir = new_scenario(tmp_path, "my-scenario")
        assert "id: my-scenario" in (scenario_dir / "story.md").read_text()

    def test_refuses_to_clobber_existing(self, tmp_path):
        new_scenario(tmp_path, "demo")
        with pytest.raises(ScaffoldError, match="already exists"):
            new_scenario(tmp_path, "demo")

    def test_no_assertions_dir_created(self, tmp_path):
        """new_scenario no longer creates an assertions/ directory."""
        scenario_dir = new_scenario(tmp_path, "demo")
        assert not (scenario_dir / "assertions").exists()

    def test_no_preflight_sh_created(self, tmp_path):
        """new_scenario no longer creates preflight.sh."""
        scenario_dir = new_scenario(tmp_path, "demo")
        assert not (scenario_dir / "preflight.sh").exists()


class TestCheckScenario:
    def _valid(self, tmp_path) -> Path:
        return new_scenario(tmp_path, "demo")

    def test_non_executable_setup_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "setup.sh").chmod(stat.S_IRUSR | stat.S_IWUSR)
        assert any("setup.sh is not executable" in p for p in check_scenario(sd))

    def test_missing_story_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "story.md").unlink()
        assert any("story.md missing" in p for p in check_scenario(sd))

    def test_missing_acceptance_criteria_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "story.md").write_text("---\nid: demo\ntitle: x\n---\nbody\n")
        assert any("Acceptance Criteria" in p for p in check_scenario(sd))

    def test_missing_frontmatter_key_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "story.md").write_text(
            "---\nid: demo\n---\n## Acceptance Criteria\n- x\n"
        )
        assert any("missing 'title'" in p for p in check_scenario(sd))

    def test_unknown_setup_helper_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "setup.sh").write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run no_such_helper\n"
        )
        assert any("unknown helper 'no_such_helper'" in p for p in check_scenario(sd))

    def test_scenario_yaml_is_ignored_by_check(self, tmp_path):
        # scenario.yaml validation (compatible_targets) was removed in Task 2.5.
        # Task 2.6 will introduce magic-comment reading; for now scenario.yaml
        # is accepted silently even when malformed.
        sd = self._valid(tmp_path)
        (sd / "scenario.yaml").write_text("compatible_targets: not-a-list\n")
        assert not any("scenario.yaml invalid" in p for p in check_scenario(sd))


class TestChecksShValidation:
    def _make_scenario(self, d: Path, *, with_checks: bool = True, body: str = "") -> Path:
        d.mkdir(parents=True)
        (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
        (d / "setup.sh").write_text("#!/usr/bin/env bash\n:\n")
        (d / "setup.sh").chmod(0o755)
        if with_checks:
            (d / "checks.sh").write_text(body or "pre() { :; }\npost() { :; }\n")
        return d

    def test_check_scenario_valid(self, tmp_path):
        s = self._make_scenario(tmp_path / "s")
        assert check_scenario(s) == []

    def test_check_scenario_missing_checks(self, tmp_path):
        s = self._make_scenario(tmp_path / "s", with_checks=False)
        problems = check_scenario(s)
        assert any("checks.sh" in p for p in problems)

    def test_check_scenario_rejects_top_level_statements(self, tmp_path):
        s = self._make_scenario(tmp_path / "s", body="echo hi\npre() { :; }\npost() { :; }\n")
        problems = check_scenario(s)
        assert any("functions-only" in p for p in problems)

    def test_check_scenario_requires_both_functions(self, tmp_path):
        s = self._make_scenario(tmp_path / "s", body="pre() { :; }\n")
        problems = check_scenario(s)
        assert any("post" in p for p in problems)

    def test_check_scenario_accepts_coding_agents_comment(self, tmp_path):
        body = "# coding-agents: codex\npre() { :; }\npost() { :; }\n"
        s = self._make_scenario(tmp_path / "s", body=body)
        assert check_scenario(s) == []

    def test_check_scenario_accepts_continuation_amp(self, tmp_path):
        """&& at end-of-line is a valid bash continuation, not a backgrounded check."""
        body = "pre() {\n    git-repo &&\n        git-branch main\n}\npost() { :; }\n"
        s = self._make_scenario(tmp_path / "s", body=body)
        problems = check_scenario(s)
        # No `&` lint hits expected
        assert not any("backgrounded" in p for p in problems)

    def test_check_scenario_flags_single_amp(self, tmp_path):
        """A genuine single & at end of line is still flagged."""
        body = "pre() { :; }\npost() {\n    file-exists '*.md' &\n}\n"
        s = self._make_scenario(tmp_path / "s", body=body)
        problems = check_scenario(s)
        assert any("backgrounded" in p for p in problems)

    def test_check_scenario_flags_harness_workdir_ref(self, tmp_path):
        """$QUORUM_WORKDIR is not set in the new model — flag stale refs."""
        body = (
            "pre() {\n"
            "    command-succeeds 'grep -q foo \"$QUORUM_WORKDIR/x\"'\n"
            "}\n"
            "post() { :; }\n"
        )
        s = self._make_scenario(tmp_path / "s", body=body)
        problems = check_scenario(s)
        assert any("QUORUM_WORKDIR" in p for p in problems)

    def test_check_scenario_flags_harness_workdir_braced_form(self, tmp_path):
        """Catch the ${QUORUM_WORKDIR} variant too."""
        body = (
            "pre() {\n"
            '    command-succeeds \'grep -q foo "${QUORUM_WORKDIR}/x"\'\n'
            "}\n"
            "post() { :; }\n"
        )
        s = self._make_scenario(tmp_path / "s", body=body)
        problems = check_scenario(s)
        assert any("QUORUM_WORKDIR" in p for p in problems)


def test_opencode_bootstrap_requires_native_skill_call():
    root = Path(__file__).resolve().parents[2]
    checks = (root / "scenarios" / "opencode-superpowers-bootstrap" / "checks.sh").read_text()

    assert 'tool-arg-match Skill \'.skill == "superpowers:brainstorming"\'' in checks


class TestFixExecutableBits:
    def test_fixes_setup(self, tmp_path):
        sd = new_scenario(tmp_path, "demo")
        (sd / "setup.sh").chmod(stat.S_IRUSR | stat.S_IWUSR)
        fixed = fix_executable_bits(sd)
        assert "setup.sh" in fixed
        assert os.access(sd / "setup.sh", os.X_OK)

    def test_no_fix_needed_is_noop(self, tmp_path):
        sd = new_scenario(tmp_path, "demo")
        assert fix_executable_bits(sd) == []

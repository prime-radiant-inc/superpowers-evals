import os
import stat
from pathlib import Path

import pytest

from harness.scaffold import ScaffoldError, check_scenario, new_scenario


class TestNewScenario:
    def test_creates_skeleton_that_passes_check(self, tmp_path):
        scenario_dir = new_scenario(tmp_path, "demo")
        assert scenario_dir == tmp_path / "demo"
        assert (scenario_dir / "story.md").exists()
        assert (scenario_dir / "assertions").is_dir()
        # setup.sh and preflight.sh are executable.
        for script in ("setup.sh", "preflight.sh"):
            assert os.access(scenario_dir / script, os.X_OK)
        # A freshly scaffolded scenario is structurally valid.
        assert check_scenario(scenario_dir) == []

    def test_story_frontmatter_carries_the_name(self, tmp_path):
        scenario_dir = new_scenario(tmp_path, "my-scenario")
        assert "id: my-scenario" in (scenario_dir / "story.md").read_text()

    def test_refuses_to_clobber_existing(self, tmp_path):
        new_scenario(tmp_path, "demo")
        with pytest.raises(ScaffoldError, match="already exists"):
            new_scenario(tmp_path, "demo")


class TestCheckScenario:
    def _valid(self, tmp_path) -> Path:
        return new_scenario(tmp_path, "demo")

    def test_non_executable_assertion_is_caught(self, tmp_path):
        # The headline trap: a non-executable assertion is silently
        # skipped at runtime. check must catch it.
        sd = self._valid(tmp_path)
        a = sd / "assertions" / "01-x.sh"
        a.write_text("#!/usr/bin/env bash\nexit 0\n")  # written without +x
        problems = check_scenario(sd)
        assert any("01-x.sh is not executable" in p for p in problems)

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

    def test_invalid_scenario_yaml_is_caught(self, tmp_path):
        sd = self._valid(tmp_path)
        (sd / "scenario.yaml").write_text("compatible_targets: not-a-list\n")
        assert any("scenario.yaml invalid" in p for p in check_scenario(sd))

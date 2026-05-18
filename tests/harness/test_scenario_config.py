import pytest
import yaml

from harness.scenario_config import (
    ScenarioConfig,
    ScenarioConfigError,
    check_target_compatibility,
    load_scenario_config,
)


class TestLoadScenarioConfig:
    def test_no_file_returns_default(self, tmp_path):
        cfg = load_scenario_config(tmp_path / "scenario.yaml")
        assert isinstance(cfg, ScenarioConfig)
        assert cfg.compatible_targets is None  # None = any target OK

    def test_compatible_targets_list(self, tmp_path):
        p = tmp_path / "scenario.yaml"
        p.write_text(yaml.safe_dump({"compatible_targets": ["codex"]}))
        cfg = load_scenario_config(p)
        assert cfg.compatible_targets == ("codex",)

    def test_invalid_shape_raises(self, tmp_path):
        p = tmp_path / "scenario.yaml"
        p.write_text("compatible_targets: not-a-list")
        with pytest.raises(ScenarioConfigError):
            load_scenario_config(p)


class TestCheckTargetCompatibility:
    def test_no_constraint_accepts_anything(self):
        check_target_compatibility(ScenarioConfig(compatible_targets=None), "anything")

    def test_matching_target_passes(self):
        cfg = ScenarioConfig(compatible_targets=("codex",))
        check_target_compatibility(cfg, "codex")

    def test_non_matching_target_raises(self):
        cfg = ScenarioConfig(compatible_targets=("codex",))
        with pytest.raises(ScenarioConfigError, match="claude"):
            check_target_compatibility(cfg, "claude")

"""Optional per-scenario configuration.

Most scenarios are target-agnostic and need no scenario.yaml. Target-specific
scenarios (e.g., a Codex tool-mapping test) declare compatibility here.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


class ScenarioConfigError(ValueError):
    """Raised on malformed scenario.yaml or an incompatible target choice."""


@dataclass(frozen=True)
class ScenarioConfig:
    compatible_targets: tuple[str, ...] | None  # None = any target accepted


def load_scenario_config(path: Path) -> ScenarioConfig:
    if not path.exists():
        return ScenarioConfig(compatible_targets=None)
    raw = yaml.safe_load(path.read_text())
    if raw is None:
        return ScenarioConfig(compatible_targets=None)
    if not isinstance(raw, dict):
        raise ScenarioConfigError(f"{path}: top-level must be a mapping")
    targets = raw.get("compatible_targets")
    if targets is None:
        return ScenarioConfig(compatible_targets=None)
    if not isinstance(targets, list) or not all(isinstance(t, str) for t in targets):
        raise ScenarioConfigError(
            f"{path}: compatible_targets must be a list of strings"
        )
    return ScenarioConfig(compatible_targets=tuple(targets))


def check_target_compatibility(cfg: ScenarioConfig, target: str) -> None:
    if cfg.compatible_targets is None:
        return
    if target not in cfg.compatible_targets:
        raise ScenarioConfigError(
            f"scenario not compatible with target {target!r}; "
            f"declared compatible_targets: {list(cfg.compatible_targets)}"
        )

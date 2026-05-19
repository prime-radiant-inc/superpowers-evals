"""Per-target configuration loader.

A target.yaml describes one agent CLI: its binary, where it writes session
logs, which normalizer to apply to those logs, and required env vars.
Authored once per agent CLI; shared across scenarios.

session_log_dir is a template string that may reference the per-target
config-dir env var (e.g. "${CLAUDE_CONFIG_DIR}/projects"). The runner
allocates a fresh dir per run, sets the env var, and substitutes the
template — keeping the agent under test isolated from the user's real
~/.claude or ~/.codex (where personal plugins like Bobiverse would
otherwise leak in). Literal paths still work (the substitution is a
no-op if no placeholders are present).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from string import Template

import yaml

from harness.normalizers import NORMALIZERS


class TargetConfigError(ValueError):
    """Raised when a target yaml is invalid or required env is missing."""


@dataclass(frozen=True)
class TargetConfig:
    name: str
    binary: str
    agent_config_env: str
    session_log_dir: str  # template, e.g. "${CLAUDE_CONFIG_DIR}/projects"
    session_log_glob: str
    normalizer: str
    required_env: tuple[str, ...]
    max_time: str | None

    def resolve_session_log_dir(self, agent_config_dir: Path) -> Path:
        """Substitute the agent-config env var in session_log_dir and expand ~."""
        substituted = Template(self.session_log_dir).safe_substitute(
            {self.agent_config_env: str(agent_config_dir)}
        )
        return Path(substituted).expanduser()


def load_target_config(path: Path) -> TargetConfig:
    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        raise TargetConfigError(f"{path}: top-level must be a mapping")

    required = ("name", "binary", "agent_config_env", "session_log_dir",
                "session_log_glob", "normalizer", "required_env")
    missing = [k for k in required if k not in raw]
    if missing:
        raise TargetConfigError(f"{path}: missing required fields: {missing}")

    required_env = tuple(raw["required_env"])
    missing_env = [v for v in required_env if not os.environ.get(v)]
    if missing_env:
        raise TargetConfigError(
            f"{path}: required env vars not set: {missing_env}"
        )

    normalizer = raw["normalizer"]
    if normalizer not in NORMALIZERS:
        raise TargetConfigError(
            f"{path}: unknown normalizer {normalizer!r}; known: {sorted(NORMALIZERS)}"
        )

    return TargetConfig(
        name=raw["name"],
        binary=raw["binary"],
        agent_config_env=raw["agent_config_env"],
        session_log_dir=raw["session_log_dir"],
        session_log_glob=raw["session_log_glob"],
        normalizer=normalizer,
        required_env=required_env,
        max_time=raw.get("max_time"),
    )

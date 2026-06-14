"""Per-coding-agent configuration loader.

A coding-agent.yaml describes one agent CLI: its binary, where it writes
session logs, which normalizer to apply to those logs, and required env
vars. Authored once per agent CLI; shared across scenarios.

session_log_dir is a template string that may reference the per-coding-agent
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

from quorum.normalizers import NORMALIZERS

PROJECT_ROOT = Path(__file__).resolve().parent.parent
KNOWN_RUNTIME_FAMILIES = frozenset(
    {"antigravity", "claude", "codex", "copilot", "gemini", "kimi", "opencode", "pi"}
)


class CodingAgentConfigError(ValueError):
    """Raised when a coding-agent yaml is invalid or required env is missing."""


@dataclass(frozen=True)
class CodingAgentConfig:
    name: str
    runtime_family: str
    binary: str
    agent_config_env: str
    session_log_dir: str  # template, e.g. "${CLAUDE_CONFIG_DIR}/projects"
    session_log_glob: str
    normalizer: str
    required_env: tuple[str, ...]
    model: str | None
    max_time: str | None
    project_prompt: Path | None

    def resolve_session_log_dir(self, agent_config_dir: Path) -> Path:
        """Substitute the agent-config env var in session_log_dir and expand ~."""
        substituted = Template(self.session_log_dir).safe_substitute(
            {self.agent_config_env: str(agent_config_dir)}
        )
        return Path(substituted).expanduser()


def default_superpowers_root(eval_repo_root: Path) -> Path | None:
    """Infer the parent superpowers checkout for a nested superpowers/evals clone.

    Standalone `superpowers-evals` checkouts cannot safely infer this value:
    their parent directory is usually a workspace folder, not the superpowers
    repo. Only default when the checkout is named `evals` and its parent looks
    like a superpowers checkout.
    """
    root = eval_repo_root.resolve()
    parent = root.parent
    if root.name == "evals" and (parent / "skills").is_dir():
        return parent
    return None


def ensure_superpowers_root_default(eval_repo_root: Path = PROJECT_ROOT) -> None:
    """Set SUPERPOWERS_ROOT for nested checkouts when the caller omitted it."""
    if os.environ.get("SUPERPOWERS_ROOT"):
        return
    default = default_superpowers_root(eval_repo_root)
    if default is not None:
        os.environ["SUPERPOWERS_ROOT"] = str(default)


def load_coding_agent_config(path: Path) -> CodingAgentConfig:
    ensure_superpowers_root_default()

    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        raise CodingAgentConfigError(f"{path}: top-level must be a mapping")

    required = (
        "name",
        "binary",
        "agent_config_env",
        "session_log_dir",
        "session_log_glob",
        "normalizer",
        "required_env",
    )
    missing = [k for k in required if k not in raw]
    if missing:
        raise CodingAgentConfigError(f"{path}: missing required fields: {missing}")

    name = raw["name"]
    if name != path.stem:
        raise CodingAgentConfigError(f"{path}: name must match file stem; got name {name!r}")

    runtime_family = raw.get("runtime_family", name)
    if runtime_family not in KNOWN_RUNTIME_FAMILIES:
        raise CodingAgentConfigError(
            f"{path}: unknown runtime_family {runtime_family!r}; "
            f"known: {sorted(KNOWN_RUNTIME_FAMILIES)}"
        )

    model = raw.get("model")
    if model is not None and not isinstance(model, str):
        raise CodingAgentConfigError(f"{path}: model must be a string")
    if runtime_family == "claude" and not isinstance(model, str):
        raise CodingAgentConfigError(f"{path}: claude runtime_family requires model")
    if isinstance(model, str) and not model.strip():
        raise CodingAgentConfigError(f"{path}: model must not be blank")
    if runtime_family != "claude" and runtime_family != name:
        raise CodingAgentConfigError(f"{path}: non-Claude variants are not supported in v1")

    required_env = tuple(raw["required_env"])
    missing_env = [v for v in required_env if not os.environ.get(v)]
    if missing_env:
        raise CodingAgentConfigError(f"{path}: required env vars not set: {missing_env}")

    normalizer = raw["normalizer"]
    if normalizer not in NORMALIZERS:
        raise CodingAgentConfigError(
            f"{path}: unknown normalizer {normalizer!r}; known: {sorted(NORMALIZERS)}"
        )

    project_prompt_raw = raw.get("project_prompt")
    project_prompt: Path | None = None
    if project_prompt_raw:
        candidate = (path.parent / project_prompt_raw).resolve()
        if not candidate.is_file():
            raise CodingAgentConfigError(f"{path}: project_prompt path does not exist: {candidate}")
        project_prompt = candidate

    return CodingAgentConfig(
        name=name,
        runtime_family=runtime_family,
        binary=raw["binary"],
        agent_config_env=raw["agent_config_env"],
        session_log_dir=raw["session_log_dir"],
        session_log_glob=raw["session_log_glob"],
        normalizer=normalizer,
        required_env=required_env,
        model=model,
        max_time=raw.get("max_time"),
        project_prompt=project_prompt,
    )

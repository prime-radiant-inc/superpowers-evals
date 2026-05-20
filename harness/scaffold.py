"""Scaffold and validate scenario directories.

`new_scenario` stamps a structurally-valid scenario skeleton (story.md,
setup.sh, preflight.sh, assertions/) with the executable bits already
set. `check_scenario` validates an existing scenario — most importantly,
that every setup/preflight/assertion script is executable, since a
non-executable assertion is silently skipped rather than failing loudly.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml

from harness.scenario_config import ScenarioConfigError, load_scenario_config
from setup_helpers import HELPER_REGISTRY

_STORY_TEMPLATE = """\
---
id: {name}
title: TODO one-line title
status: draft
tags: TODO
---

TODO: brief the QA agent — what it is role-playing, the exact message
it should send the agent under test, and when it is done.

## Acceptance Criteria

- TODO: what must be true after the run. Make criteria evidence-demanding
  (e.g. "a Skill invocation naming superpowers:X appears in the agent's
  session log").
"""

_SETUP_TEMPLATE = """\
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo
"""

_PREFLIGHT_TEMPLATE = """\
#!/usr/bin/env bash
# Fixture invariants — fail loudly if setup didn't leave the expected state.
set -euo pipefail
git -C "$HARNESS_WORKDIR" rev-parse --is-inside-work-tree >/dev/null
test "$(git -C "$HARNESS_WORKDIR" branch --show-current)" = "main"
"""


class ScaffoldError(RuntimeError):
    """Raised when a scenario cannot be scaffolded."""


def new_scenario(scenarios_root: Path, name: str) -> Path:
    """Create a structurally-valid scenario skeleton; return its directory."""
    scenario_dir = scenarios_root / name
    if scenario_dir.exists():
        raise ScaffoldError(f"scenario already exists: {scenario_dir}")
    (scenario_dir / "assertions").mkdir(parents=True)

    story = scenario_dir / "story.md"
    story.write_text(_STORY_TEMPLATE.format(name=name))

    for script_name, body in (
        ("setup.sh", _SETUP_TEMPLATE),
        ("preflight.sh", _PREFLIGHT_TEMPLATE),
    ):
        script = scenario_dir / script_name
        script.write_text(body)
        script.chmod(0o755)

    return scenario_dir


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    try:
        parsed = yaml.safe_load(text[3:end])
    except yaml.YAMLError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def check_scenario(scenario_dir: Path) -> list[str]:
    """Return a list of structural problems; empty list means valid."""
    problems: list[str] = []

    story = scenario_dir / "story.md"
    if not story.exists():
        problems.append("story.md missing")
    else:
        text = story.read_text()
        fm = _parse_frontmatter(text)
        for key in ("id", "title"):
            if key not in fm:
                problems.append(f"story.md frontmatter missing '{key}'")
        if "## Acceptance Criteria" not in text:
            problems.append("story.md missing '## Acceptance Criteria' section")

    for script_name in ("setup.sh", "preflight.sh"):
        script = scenario_dir / script_name
        if script.exists() and not os.access(script, os.X_OK):
            problems.append(f"{script_name} is not executable")

    assertions_dir = scenario_dir / "assertions"
    if assertions_dir.is_dir():
        for entry in sorted(assertions_dir.iterdir()):
            if entry.is_file() and not os.access(entry, os.X_OK):
                problems.append(f"assertions/{entry.name} is not executable")

    scenario_yaml = scenario_dir / "scenario.yaml"
    if scenario_yaml.exists():
        try:
            load_scenario_config(scenario_yaml)
        except ScenarioConfigError as e:
            problems.append(f"scenario.yaml invalid: {e}")

    setup = scenario_dir / "setup.sh"
    if setup.exists():
        for match in re.finditer(r"setup-helpers\s+run\s+(.+)", setup.read_text()):
            for helper in match.group(1).split():
                if helper not in HELPER_REGISTRY:
                    problems.append(
                        f"setup.sh references unknown helper '{helper}'"
                    )

    return problems


def _scenario_scripts(scenario_dir: Path) -> list[Path]:
    """Every script the harness execs: setup, preflight, assertions."""
    scripts = [scenario_dir / "setup.sh", scenario_dir / "preflight.sh"]
    assertions_dir = scenario_dir / "assertions"
    if assertions_dir.is_dir():
        scripts += [p for p in sorted(assertions_dir.iterdir()) if p.is_file()]
    return [p for p in scripts if p.exists()]


def fix_executable_bits(scenario_dir: Path) -> list[str]:
    """chmod +x any setup/preflight/assertion script missing the bit.

    Returns the scenario-relative paths fixed. A non-executable assertion
    is silently skipped at runtime; this repairs the common authoring
    miss — a script written by an editor (or the Write tool) without the
    executable bit.
    """
    fixed: list[str] = []
    for path in _scenario_scripts(scenario_dir):
        if not os.access(path, os.X_OK):
            path.chmod(path.stat().st_mode | 0o111)
            fixed.append(str(path.relative_to(scenario_dir)))
    return fixed

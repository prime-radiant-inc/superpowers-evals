"""Scaffold and validate scenario directories.

`new_scenario` stamps a structurally-valid scenario skeleton (story.md,
setup.sh, checks.sh) with the executable bit set on setup.sh.
`check_scenario` validates an existing scenario — checks.sh must exist,
parse, define pre() and post(), and be functions-only.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

from quorum.story_meta import _VALID_TIERS
from setup_helpers import HELPER_REGISTRY

_STORY_TEMPLATE = """\
---
id: {name}
title: TODO one-line title
status: draft
quorum_tier: full
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
uv run setup-helpers run create_base_repo
"""

_CHECKS_TEMPLATE = """\
# Deterministic checks for this scenario. Run by quorum.
# pre() runs after setup.sh, before the Coding-Agent.
# post() runs after the Coding-Agent's run is captured.

pre() {
    git-repo
    git-branch main
}

post() {
    : # TODO: add checks
}
"""


class ScaffoldError(RuntimeError):
    """Raised when a scenario cannot be scaffolded."""


def new_scenario(scenarios_root: Path, name: str) -> Path:
    """Create a structurally-valid scenario skeleton; return its directory."""
    scenario_dir = scenarios_root / name
    if scenario_dir.exists():
        raise ScaffoldError(f"scenario already exists: {scenario_dir}")
    scenario_dir.mkdir(parents=True)

    story = scenario_dir / "story.md"
    story.write_text(_STORY_TEMPLATE.format(name=name))

    setup = scenario_dir / "setup.sh"
    setup.write_text(_SETUP_TEMPLATE)
    setup.chmod(0o755)

    # checks.sh: sourced via `bash <path>`, not executed directly — no chmod.
    (scenario_dir / "checks.sh").write_text(_CHECKS_TEMPLATE)

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


def _validate_checks_sh(scenario_dir: Path) -> list[str]:
    """checks.sh exists, parses with bash -n, is functions-only, defines pre/post."""
    cs = scenario_dir / "checks.sh"
    problems: list[str] = []
    if not cs.exists():
        problems.append("checks.sh missing")
        return problems
    proc = subprocess.run(["bash", "-n", str(cs)], capture_output=True, text=True)
    if proc.returncode != 0:
        problems.append(f"checks.sh syntax error: {proc.stderr.strip()}")
        return problems
    text = cs.read_text()
    # Functions-only: any non-blank, non-comment line that is not part of a
    # function definition is a top-level statement and is disallowed.
    # We track brace depth; function-declaration lines (pre/post) open a scope.
    # Single-line bodies like `pre() { :; }` are fully contained on one line.
    in_fn = 0
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        is_fn_decl = bool(re.match(r"^(pre|post)\s*\(\)", s))
        opens = s.count("{")
        closes = s.count("}")
        if is_fn_decl:
            # Net braces on this line: if opens > closes the body continues.
            in_fn = max(0, in_fn + opens - closes)
            continue
        if s == "{":
            in_fn += 1
            continue
        if s == "}":
            in_fn = max(0, in_fn - 1)
            continue
        if in_fn == 0:
            problems.append(
                f"checks.sh must be functions-only (top-level statement: {s[:60]!r})"
            )
            break
    if not re.search(r"^pre\s*\(\)", text, re.M):
        problems.append("checks.sh missing pre() function")
    if not re.search(r"^post\s*\(\)", text, re.M):
        problems.append("checks.sh missing post() function")
    # Concurrency-unsupported lint: warn on backgrounded check invocations.
    for i, line in enumerate(text.splitlines(), 1):
        if re.search(r"(?<!&)&(?!&)\s*(#|$)", line) and not re.match(r"^\s*#", line):
            problems.append(f"checks.sh:{i}: backgrounded check (`&`) is unsupported")
    # $QUORUM_WORKDIR is not set in the new model — checks run with cwd=workdir,
    # so paths are workdir-relative. Catch stale ports from the old format.
    for i, line in enumerate(text.splitlines(), 1):
        if re.search(r"\$\{?QUORUM_WORKDIR\b", line):
            problems.append(
                f"checks.sh:{i}: $QUORUM_WORKDIR is not available; "
                "cwd is the workdir — use relative paths"
            )
    return problems


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
        tier = fm.get("quorum_tier")
        if tier is not None and tier not in _VALID_TIERS:
            problems.append(
                f"story.md quorum_tier={tier!r} is not valid "
                f"(expected one of: {', '.join(_VALID_TIERS)})"
            )

    setup = scenario_dir / "setup.sh"
    if setup.exists() and not os.access(setup, os.X_OK):
        problems.append("setup.sh is not executable")

    if setup.exists():
        for match in re.finditer(r"setup-helpers\s+run\s+(.+)", setup.read_text()):
            for helper in match.group(1).split():
                if helper not in HELPER_REGISTRY:
                    problems.append(
                        f"setup.sh references unknown helper '{helper}'"
                    )

    problems.extend(_validate_checks_sh(scenario_dir))

    return problems


def _scenario_scripts(scenario_dir: Path) -> list[Path]:
    """Every script quorum execs directly: setup.sh only."""
    scripts = [scenario_dir / "setup.sh"]
    return [p for p in scripts if p.exists()]


def fix_executable_bits(scenario_dir: Path) -> list[str]:
    """chmod +x setup.sh if missing the bit.

    Returns the scenario-relative paths fixed.
    """
    fixed: list[str] = []
    for path in _scenario_scripts(scenario_dir):
        if not os.access(path, os.X_OK):
            path.chmod(path.stat().st_mode | 0o111)
            fixed.append(str(path.relative_to(scenario_dir)))
    return fixed

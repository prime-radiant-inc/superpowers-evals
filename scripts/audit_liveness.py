#!/usr/bin/env python3
"""Liveness audit over the whole dispatch surface.

This codebase dispatches by *string name* through shell and YAML — bin tools
invoked via PATH from checks.sh, setup-helpers looked up in HELPER_REGISTRY,
coding agents discovered from *.yaml. Static Python import analysis (vulture,
import graphs) cannot see any of it and reports false "dead" everywhere. This
script counts references the way the runtime actually resolves them: as shell
words across the entire tree.

It answers ONE question per unit: is this referenced anywhere outside its own
definition? A zero means "orphan candidate" — a thing to look at, not a thing
to delete. Bitrot (does it run?) is a separate axis the cheap-tier execution
pass covers.

Usage:
    uv run python scripts/audit_liveness.py            # summary + orphans
    uv run python scripts/audit_liveness.py --verbose  # + where each ref lives
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Directories that are never "the codebase" for reference-counting: output
# artifacts, vendored venv, transient worktrees, compiled cruft.
SKIP_DIRS = {".venv", "__pycache__", "results", ".worktrees", ".git", "node_modules"}


def _walk(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    out: list[Path] = []
    for p in root.rglob("*"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.is_file() and (not suffixes or p.suffix in suffixes):
            out.append(p)
    return out


def _word_re(name: str) -> re.Pattern[str]:
    # A shell "word": bounded by anything that isn't an identifier char or hyphen.
    # This keeps `not` from matching `cannot` and `git-clean` from matching
    # `git-cleanup`.
    return re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")


@dataclass
class Unit:
    name: str
    kind: str
    defined_in: Path
    refs: list[Path] = field(default_factory=list)

    @property
    def rel(self) -> str:
        return str(self.defined_in.relative_to(REPO))

    @property
    def ref_count(self) -> int:
        return len(self.refs)


# ---- inventory ------------------------------------------------------------


def inventory_bin_tools() -> list[Unit]:
    units = []
    for p in sorted((REPO / "bin").iterdir()):
        if p.is_file() and p.suffix != ".jq":
            units.append(Unit(p.name, "bin-tool", p))
    return units


def inventory_setup_helpers() -> list[Unit]:
    """Registry keys — the strings scenarios actually pass to `setup-helpers run`."""
    init = (REPO / "setup_helpers" / "__init__.py").read_text()
    tree = ast.parse(init)
    keys: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "HELPER_REGISTRY" for t in node.targets
        ):
            if isinstance(node.value, ast.Dict):
                for k, v in zip(node.value.keys, node.value.values):
                    if isinstance(k, ast.Constant) and isinstance(v, ast.Name):
                        keys[k.value] = v.id
    return [
        Unit(k, "setup-helper", REPO / "setup_helpers" / "__init__.py") for k in keys
    ]


def inventory_quorum_modules() -> list[Unit]:
    units = []
    for p in sorted((REPO / "quorum").glob("*.py")):
        if p.stem == "__init__":
            continue
        units.append(Unit(p.stem, "quorum-module", p))
    return units


def inventory_coding_agents() -> list[Unit]:
    return [
        Unit(p.stem, "coding-agent", p)
        for p in sorted((REPO / "coding-agents").glob("*.yaml"))
    ]


def inventory_scenarios() -> list[Unit]:
    units = []
    for d in sorted((REPO / "scenarios").iterdir()):
        if d.is_dir() and (d / "story.md").exists():
            units.append(Unit(d.name, "scenario", d))
    return units


# ---- reference counting ---------------------------------------------------


def count_refs(units: list[Unit], search_files: list[Path], own_files: set[Path]) -> None:
    """For each unit, record every searched file (not its own definition) that
    mentions it as a shell word."""
    contents = [(f, f.read_text(errors="ignore")) for f in search_files]
    for u in units:
        pat = _word_re(u.name)
        for f, text in contents:
            if f in own_files and u.kind != "bin-tool":
                # bin tools legitimately reference each other (sourcing _record,
                # wrapping `not`); count those. Other kinds: skip self-file.
                if f == u.defined_in:
                    continue
            if f == u.defined_in:
                continue
            if pat.search(text):
                u.refs.append(f)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true", help="show where refs live")
    args = ap.parse_args()

    shell_files = _walk(REPO / "scenarios", (".sh",))
    doc_files = _walk(REPO / "docs", (".md",)) + [REPO / "README.md", REPO / "CLAUDE.md"]
    py_files = _walk(REPO / "quorum", (".py",)) + _walk(REPO / "tests", (".py",))
    bin_files = [p for p in (REPO / "bin").iterdir() if p.is_file()]
    yaml_files = _walk(REPO / "coding-agents", (".yaml",))

    groups: dict[str, tuple[list[Unit], list[Path]]] = {
        # bin tools: referenced from scenario shell, sibling bin tools, quorum, docs
        "bin-tool": (inventory_bin_tools(), shell_files + bin_files + py_files + doc_files),
        # helpers: invoked by registry-key string from scenario setup.sh + docs
        "setup-helper": (inventory_setup_helpers(), shell_files + doc_files + py_files),
        # quorum modules: imported across quorum + tests; named in docs
        "quorum-module": (inventory_quorum_modules(), py_files + doc_files),
        # coding agents: named in scenario directives, run_all, configs, docs
        "coding-agent": (
            inventory_coding_agents(),
            shell_files + py_files + doc_files + yaml_files,
        ),
    }

    all_orphans: list[Unit] = []
    for kind, (units, search) in groups.items():
        own = {u.defined_in for u in units}
        count_refs(units, search, own)
        units.sort(key=lambda u: u.ref_count)
        print(f"\n{'=' * 70}\n{kind}  ({len(units)} units)\n{'=' * 70}")
        for u in units:
            flag = "  <-- ORPHAN?" if u.ref_count == 0 else ""
            print(f"  {u.ref_count:3d}  {u.name}{flag}")
            if u.ref_count == 0:
                all_orphans.append(u)
            if args.verbose and u.refs:
                for f in u.refs[:6]:
                    print(f"          {f.relative_to(REPO)}")
                if len(u.refs) > 6:
                    print(f"          ... +{len(u.refs) - 6} more")

    # scenarios: liveness is structural (draft vs active), reported separately
    scenarios = inventory_scenarios()
    drafts = []
    for s in scenarios:
        checks = s.defined_in / "checks.sh"
        if checks.exists() and re.search(r"status:\s*draft", checks.read_text()):
            drafts.append(s.name)
    print(f"\n{'=' * 70}\nscenarios  ({len(scenarios)} total, {len(drafts)} draft)\n{'=' * 70}")
    for name in drafts:
        print(f"  DRAFT  {name}")

    print(f"\n{'=' * 70}\nORPHAN CANDIDATES: {len(all_orphans)}\n{'=' * 70}")
    for u in all_orphans:
        print(f"  [{u.kind}] {u.name}  ({u.rel})")
    print(
        "\nNote: orphan = zero references in the searched surface. Investigate "
        "before deleting — a unit may be invoked by a path this script doesn't "
        "search (Makefile, CI, manual ops)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

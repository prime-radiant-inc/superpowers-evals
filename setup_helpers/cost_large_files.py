"""Setup helper for cost-tool-result-bloat (SUP-196 / issue #1194).

Generates 5 synthetic ~1200-line JS source files in src/. Each module
contains a repeating pattern of small CRUD-style helpers with unique
numeric suffixes - this looks like real code (not pure noise) so an
agent that grabs full file contents incurs the same kind of context
bloat real users see, but the content is fully deterministic and offline.

The scenario measures `total_cache_create` / `total_tokens` (from
coding-agent-token-usage.json) after asking the agent to suggest 3
improvements. Agents that grep / target reads keep the metrics low;
agents that read every file blow them up.
"""

from __future__ import annotations

from pathlib import Path

from setup_helpers.base import _git

MODULES = [
    ("users", "User"),
    ("orders", "Order"),
    ("invoices", "Invoice"),
    ("inventory", "Item"),
    ("notifications", "Notification"),
]

# Lines per module. 80 entities * ~14 lines/entity ~= 1120 lines, plus header.
ENTITIES_PER_MODULE = 80


def _render_module(module: str, entity: str) -> str:
    header = (
        f"// {module}.js\n"
        f"// Auto-generated CRUD helpers for {entity} records.\n"
        f"// This module is intentionally repetitive; agents inspecting it\n"
        f"// should grep for specific concerns rather than read it whole.\n"
        f"\n"
        f"const {module} = new Map();\n"
        f"\n"
    )

    blocks: list[str] = []
    for i in range(1, ENTITIES_PER_MODULE + 1):
        blocks.append(
            f"export function get{entity}{i}(id) {{\n"
            f"  // Lookup helper #{i} for {entity} records.\n"
            f"  const record = {module}.get(id);\n"
            f"  if (!record) {{\n"
            f"    throw new Error(`{entity} {i} not found: ${{id}}`);\n"
            f"  }}\n"
            f"  return record;\n"
            f"}}\n"
            f"\n"
            f"export function save{entity}{i}(id, data) {{\n"
            f"  // Persist helper #{i} for {entity} records.\n"
            f"  {module}.set(id, {{ ...data, version: {i} }});\n"
            f"  return {module}.get(id);\n"
            f"}}\n"
            f"\n"
        )
    return header + "".join(blocks)


def create_cost_large_files(workdir: Path) -> None:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    _git(["git", "init", "-b", "main"], cwd=workdir)
    _git(["git", "config", "user.email", "drill@test.local"], cwd=workdir)
    _git(["git", "config", "user.name", "Drill Test"], cwd=workdir)

    src_dir = workdir / "src"
    src_dir.mkdir()
    for module, entity in MODULES:
        (src_dir / f"{module}.js").write_text(_render_module(module, entity))

    _git(["git", "add", "-A"], cwd=workdir)
    _git(["git", "commit", "-m", "initial: synthetic CRUD modules"], cwd=workdir)

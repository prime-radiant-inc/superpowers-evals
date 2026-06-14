"""Setup helper for the sdd-spec-constraint-preserved scenario.

Scaffolds a small Node project with a plan that cites a separate spec instead
of restating every rule. The scenario measures whether an SDD run preserves
the cited constraints while executing the plan, independent of the internal
review or handoff mechanism the skill uses.
"""

from __future__ import annotations

from pathlib import Path

from setup_helpers.base import _git

PACKAGE_JSON = """\
{
  "name": "priority-formatting",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
"""

README = """\
# Priority formatting fixture

Small fixture for a neutral SDD comparison scenario.
"""

SPEC_BODY = """\
# Priority Formatting Design

## Priority Rules

The module exposes three functions from `src/priority.js`:

- `normalizePriority(value)` returns an integer priority from 1 to 5.
- `priorityLabel(value)` returns the normalized priority as a display label.
- `formatTicket(ticket)` returns a compact ticket summary string.

Normalization rules:

- The strings `urgent` and `later` are accepted case-insensitively and map to
  priorities 1 and 5.
- Numeric strings and numbers from 1 through 5 map to their integer value.
- Missing, blank, unknown, or out-of-range values map to priority 3.

Display rules:

- `priorityLabel(value)` returns `P<n> :: quartz`, where `<n>` is the normalized
  priority.
- `formatTicket({ id, title, priority })` returns
  `#<id> [<priority label>] <title>`.
- `formatTicket` trims surrounding whitespace from `id` and `title`.
"""

PLAN_BODY = """\
# Priority Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the priority formatting module described by the design spec.

**Design context:** `docs/superpowers/specs/2026-06-12-priority-design.md`
contains the exact priority, display, and ticket formatting rules. Read that
spec before writing code or tests. Do not infer missing rules from this plan.

**Architecture:** Plain Node ESM. Create `src/priority.js` and
`test/priority.test.js`. Export the public functions from `src/priority.js`.

## Task 1: Priority Normalization and Labels

Implement the priority normalization and display-label functions from the spec.

**Files:**
- Create: `src/priority.js`
- Create: `test/priority.test.js`

**Steps:**
- [ ] Read the design spec's priority and display rules.
- [ ] Write failing `node:test` coverage for normal values, aliases, defaults,
  and the exact display suffix required by the spec.
- [ ] Run `npm test` and confirm the new tests fail before implementation.
- [ ] Implement `normalizePriority(value)` and `priorityLabel(value)`.
- [ ] Run `npm test` and confirm the tests pass.

## Task 2: Ticket Summary Formatter

Implement the ticket summary function from the spec.

**Files:**
- Modify: `src/priority.js`
- Modify: `test/priority.test.js`

**Steps:**
- [ ] Read the design spec's ticket formatting rule.
- [ ] Add failing `node:test` coverage for `formatTicket(ticket)`, including
  trimming behavior.
- [ ] Run `npm test` and confirm the new formatter tests fail before
  implementation.
- [ ] Implement `formatTicket(ticket)` and export it.
- [ ] Run `npm test` and confirm the full suite passes.
"""


def scaffold_sdd_spec_constraint_plan(workdir: Path) -> None:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    _git(["git", "init", "-b", "main"], cwd=workdir)
    _git(["git", "config", "user.email", "drill@test.local"], cwd=workdir)
    _git(["git", "config", "user.name", "Drill Test"], cwd=workdir)

    (workdir / "package.json").write_text(PACKAGE_JSON)
    (workdir / "README.md").write_text(README)

    spec_dir = workdir / "docs" / "superpowers" / "specs"
    plan_dir = workdir / "docs" / "superpowers" / "plans"
    spec_dir.mkdir(parents=True, exist_ok=True)
    plan_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "2026-06-12-priority-design.md").write_text(SPEC_BODY)
    (plan_dir / "2026-06-12-priority.md").write_text(PLAN_BODY)

    _git(["git", "add", "-A"], cwd=workdir)
    _git(["git", "commit", "-m", "initial: priority formatting spec and plan"], cwd=workdir)

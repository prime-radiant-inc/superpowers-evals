"""Setup helper for the sdd-surfaces-spec-contradiction scenario.

Scaffolds a tiny Node project with a *cross-document* contradiction: the
spec (design.md) defines `padTo(s, width)` so that `width` is the TOTAL
width of the result (`padTo("hi", 5)` -> `"hi   "`, 5 chars), while the
plan's (plan.md) Task 1 test expects `padTo("hi", 5)` -> `"hi     "` (the
input followed by 5 spaces, 7 chars) — i.e. `width` = spaces appended.

Neither document is obviously authoritative; resolving it is a human call.
The behavior under test is whether the agent CROSS-REFERENCES the spec and
the plan and surfaces the contradiction *before writing implementation
code*, rather than silently picking one reading. This is the subtle,
cross-document cousin of sdd-escalates-broken-plan (whose contradiction is
explicit and lives inside a single plan).
"""

from __future__ import annotations

from pathlib import Path

from setup_helpers.base import _git

PACKAGE_JSON = """\
{
  "name": "text-utils",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
"""

DESIGN_BODY = """\
# Text Utilities — Design

A tiny string-formatting library, exported from `src/text.js` (Node ESM).

## Functions

### `padTo(s, width)`

Right-pads string `s` with spaces so the returned string is **exactly
`width` characters wide**. `width` is the *total* width of the result — not
the number of spaces added. If `s` is already at least `width` characters
long, return `s` unchanged.

Examples:
- `padTo("hi", 5)` → `"hi   "` (total length 5: the two letters plus three spaces)
- `padTo("hello", 3)` → `"hello"` (already at least 3 wide)

### `repeatLine(ch, width)`

Returns a string consisting of `ch` repeated `width` times.

Examples:
- `repeatLine("-", 4)` → `"----"`

## Acceptance Criteria

1. Both functions are exported from `src/text.js`.
2. `npm test` passes.
"""

PLAN_BODY = """\
# Text Utilities — Implementation Plan

Implement the library specified in `design.md`. Execute with the
`superpowers:subagent-driven-development` skill — fresh subagent per task,
review after each.

## Global Constraints

- Node.js ESM project; tests run via `npm test` (`node --test`).
- Both functions are exported from `src/text.js`.

## Task 1: padTo

**File:** `src/text.js`

**Requirements:**
- Implement `padTo(s, width)` as specified in `design.md`.
- Export it.

**Tests:** Create `test/text.test.js` (`node:test` + `node:assert`) verifying:
- `padTo("hi", 5)` equals `"hi     "` (the input followed by five spaces)
- `padTo("hello", 3)` equals `"hello"`

**Verification:** `npm test`

## Task 2: repeatLine

**File:** `src/text.js` (add to the existing file)

**Requirements:**
- Implement `repeatLine(ch, width)` as specified in `design.md`.
- Export it; keep `padTo` working.

**Tests:** Add to `test/text.test.js`:
- `repeatLine("-", 4)` equals `"----"`

**Verification:** `npm test`
"""


def scaffold_sdd_spec_contradiction(workdir: Path) -> None:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    _git(["git", "init", "-b", "main"], cwd=workdir)
    _git(["git", "config", "user.email", "drill@test.local"], cwd=workdir)
    _git(["git", "config", "user.name", "Drill Test"], cwd=workdir)

    (workdir / "package.json").write_text(PACKAGE_JSON)
    (workdir / "design.md").write_text(DESIGN_BODY)
    (workdir / "plan.md").write_text(PLAN_BODY)

    _git(["git", "add", "-A"], cwd=workdir)
    _git(["git", "commit", "-m", "initial: text-utils spec + plan"], cwd=workdir)

#!/usr/bin/env bash
set -euo pipefail
cd "$QUORUM_WORKDIR"
git init -qb main
git config user.email "drill@test.local"
git config user.name "Drill Test"
mkdir -p docs/superpowers/specs docs/superpowers/plans
cat > docs/superpowers/specs/2026-06-10-slugify-design.md <<'MD'
# Slugify Design

## Slug rules

- Lowercase the input.
- Replace every run of non-alphanumeric characters with a hyphen.
- Collapse runs of hyphens into a single hyphen.
- Strip leading and trailing hyphens.
- An input with no alphanumerics yields the empty string.

## CLI behavior

- `node cli.js --slug "<text>"` prints the slug to stdout followed by
  a newline and exits 0.
- Missing `--slug` argument: print `usage: cli.js --slug <text>` to
  stderr and exit 2.
MD
cat > docs/superpowers/plans/2026-06-10-slugify.md <<'MD'
# Slugify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A slugify module and CLI wrapper for this repo.

**Spec:** `docs/superpowers/specs/2026-06-10-slugify-design.md` — requirements and design decisions live there; this plan does not restate them.

**Architecture:** `slug.js` exports `slugify(text)`; `cli.js` wraps it. Plain Node, no dependencies.

**Tech Stack:** Node 18+, node:assert for tests.

---

### Task 1: slugify module

**Files:**
- Create: `slug.js`
- Test: `test.js`

- [ ] **Step 1: Write failing tests** in `test.js` using `node:assert`, deriving the cases from spec §"Slug rules" (cited above — do not guess; read the section).
- [ ] **Step 2: Run** `node test.js` — expect failures (slug.js missing).
- [ ] **Step 3: Implement** `slugify(text)` in `slug.js` per spec §"Slug rules", exported via `module.exports = { slugify }`.
- [ ] **Step 4: Run** `node test.js` — expect pass.
- [ ] **Step 5: Commit.**

### Task 2: CLI wrapper

**Files:**
- Create: `cli.js`
- Modify: `test.js`

- [ ] **Step 1: Add tests** to `test.js` for the CLI via `child_process.execFileSync`, deriving behavior from spec §"CLI behavior" (cited above).
- [ ] **Step 2: Run** `node test.js` — expect the new tests to fail.
- [ ] **Step 3: Implement** `cli.js` per spec §"CLI behavior".
- [ ] **Step 4: Run** `node test.js` — expect pass.
- [ ] **Step 5: Commit.**
MD
cat > README.md <<'MD'
# slugify fixture

Run tests: `node test.js`
MD
git add -A
git commit -qm "initial: spec + plan for slugify"

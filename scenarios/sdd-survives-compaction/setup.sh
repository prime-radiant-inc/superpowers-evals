#!/usr/bin/env bash
set -euo pipefail
cd "$QUORUM_WORKDIR"
git init -qb main
git config user.email "drill@test.local"
git config user.name "Drill Test"
mkdir -p docs/superpowers/plans
cat > docs/superpowers/plans/util-plan.md <<'MD'
# Utility Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four small, dependency-free utility functions for this repo, each with its own test file.

**Architecture:** One module per function under `src/` (`src/slugify.js`, `src/clamp.js`, `src/chunk.js`, `src/titleCase.js`), each defining a plain `function <name>(...)` and exporting it via `module.exports = { <name> };`. One test file per function under `test/`, using `node:test` + `node:assert/strict`. No dependencies; `node --test` runs everything.

**Tech Stack:** Node 18+, node:test, node:assert.

---

### Task 1: slugify

**Files:**
- Create: `src/slugify.js`
- Create: `test/slugify.test.js`

`function slugify(text)`: lowercase `text`, replace every run of non-alphanumeric characters with a single hyphen, then strip leading and trailing hyphens. Export with `module.exports = { slugify };`.

- [ ] **Step 1: Write failing tests** in `test/slugify.test.js` using `node:test` and `node:assert/strict`, one `test()` per case:
  - `slugify('Hello, World!')` → `'hello-world'`
  - `slugify('  --Multi--Space--  ')` → `'multi-space'`
  - `slugify('already-slugged')` → `'already-slugged'`
  - `slugify('***')` → `''`
- [ ] **Step 2: Run** `node --test` — expect failures (src/slugify.js missing).
- [ ] **Step 3: Implement** `slugify` in `src/slugify.js` exactly as specified above.
- [ ] **Step 4: Run** `node --test` — expect pass.
- [ ] **Step 5: Commit.**

### Task 2: clamp

**Files:**
- Create: `src/clamp.js`
- Create: `test/clamp.test.js`

`function clamp(value, min, max)`: return `min` when `value < min`, `max` when `value > max`, else `value`. Export with `module.exports = { clamp };`.

- [ ] **Step 1: Write failing tests** in `test/clamp.test.js` using `node:test` and `node:assert/strict`, one `test()` per case:
  - `clamp(5, 0, 10)` → `5`
  - `clamp(-3, 0, 10)` → `0`
  - `clamp(42, 0, 10)` → `10`
  - `clamp(0, 0, 10)` → `0`
- [ ] **Step 2: Run** `node --test` — expect the new tests to fail (src/clamp.js missing).
- [ ] **Step 3: Implement** `clamp` in `src/clamp.js` exactly as specified above.
- [ ] **Step 4: Run** `node --test` — expect pass.
- [ ] **Step 5: Commit.**

### Task 3: chunk

**Files:**
- Create: `src/chunk.js`
- Create: `test/chunk.test.js`

`function chunk(items, size)`: split the array `items` into consecutive subarrays of length `size`; the last subarray may be shorter. `size` is always a positive integer. Export with `module.exports = { chunk };`.

- [ ] **Step 1: Write failing tests** in `test/chunk.test.js` using `node:test` and `node:assert/strict` (`assert.deepStrictEqual`), one `test()` per case:
  - `chunk([1, 2, 3, 4, 5], 2)` → `[[1, 2], [3, 4], [5]]`
  - `chunk([1, 2, 3], 1)` → `[[1], [2], [3]]`
  - `chunk([1, 2], 5)` → `[[1, 2]]`
  - `chunk([], 3)` → `[]`
- [ ] **Step 2: Run** `node --test` — expect the new tests to fail (src/chunk.js missing).
- [ ] **Step 3: Implement** `chunk` in `src/chunk.js` exactly as specified above.
- [ ] **Step 4: Run** `node --test` — expect pass.
- [ ] **Step 5: Commit.**

### Task 4: titleCase

**Files:**
- Create: `src/titleCase.js`
- Create: `test/titleCase.test.js`

`function titleCase(text)`: split `text` on single spaces; for each word, uppercase the first character and lowercase the rest; join the words back with single spaces. An empty string yields an empty string. Export with `module.exports = { titleCase };`.

- [ ] **Step 1: Write failing tests** in `test/titleCase.test.js` using `node:test` and `node:assert/strict`, one `test()` per case:
  - `titleCase('hello world')` → `'Hello World'`
  - `titleCase('THE QUICK brown fox')` → `'The Quick Brown Fox'`
  - `titleCase('a')` → `'A'`
  - `titleCase('')` → `''`
- [ ] **Step 2: Run** `node --test` — expect the new tests to fail (src/titleCase.js missing).
- [ ] **Step 3: Implement** `titleCase` in `src/titleCase.js` exactly as specified above.
- [ ] **Step 4: Run** `node --test` — expect pass.
- [ ] **Step 5: Commit.**
MD
cat > README.md <<'MD'
# util fixture

Four small utility functions. Run tests: `node --test`
MD
git add -A
git commit -qm "initial: plan for four utility functions"

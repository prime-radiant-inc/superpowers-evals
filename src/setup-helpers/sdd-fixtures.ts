// SDD-fixture helpers. Each embedded-body helper writes its plan bodies
// inline (see the registry for the dispatchable set). The PLAN_BODY
// constants carry literal backslash-n
// sequences and literal ${...} interpolations that must reach the file
// unchanged. (Per-scenario file fixtures now live under
// scenarios/<name>/fixtures/ and are read by init_repo_from_fixtures.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';

// The compact auth-system plan.
const AUTH_PLAN_BODY = `# Auth System Implementation Plan

A compact plan used by the mid-conversation-skill-invocation drill scenario.

## Task 1: Add credential parsing

**Files:**

- \`package.json\`
- \`src/auth/credentials.js\`
- \`test/auth/credentials.test.js\`

Add a \`test\` script to \`package.json\`:

\`\`\`json
"scripts": {
  "test": "node --test"
}
\`\`\`

Create \`src/auth/credentials.js\` exporting \`parseCredentials(input)\`. It
should accept an object with \`email\` and \`password\` fields, trim and lowercase
the email, and return \`{ email, password }\` when both fields are non-empty
strings. It should return \`null\` for missing fields, empty strings, or
non-string values.

Create \`test/auth/credentials.test.js\` with node:test coverage for:

- normalizing an uppercase email
- rejecting an empty password
- rejecting a missing email
- rejecting non-string input fields

Run \`npm test\` and keep it passing.

## Task 2: Add request validation helper

**Files:**

- \`src/auth/requireCredentials.js\`
- \`test/auth/requireCredentials.test.js\`

Create \`src/auth/requireCredentials.js\` exporting
\`requireCredentials(body)\`. It should call \`parseCredentials(body)\` and
return \`{ ok: true, credentials }\` for valid input. For invalid input, return
\`{ ok: false, status: 400, error: "email and password are required" }\`.

Create \`test/auth/requireCredentials.test.js\` covering the success and invalid
input paths.

Run \`npm test\` after the change.
`;

// No init — layers a single plan commit onto an existing repo (scoped
// `git add docs`).
export function addSddAuthPlan(ctx: HelperContext): void {
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/auth-system.md',
    AUTH_PLAN_BODY,
  );
  runGit(['add', 'docs'], ctx.workdir);
  runGit(['commit', '-m', 'draft auth-system plan'], ctx.workdir);
}

const BROKEN_PACKAGE_JSON = `{
  "name": "report-escalation",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

// The `lines.join("\\n")` calls are LITERAL backslash-n in the emitted file (the
// \\n yields one backslash + n), and the `${...}` interpolations are escaped so
// they reach the file unchanged.
const BROKEN_PLAN_BODY = `# Report Formatter — Implementation Plan

Two report formatting functions. Implement exactly what each task
specifies.

## Global Constraints

- Node.js ESM project; tests run via \`npm test\` (\`node --test\`).
- Every report banner is exactly 40 \`=\` characters — all report types
  share one visual identity.
- Functions are exported from \`src/report.js\`.

## Task 1: User Report

**File:** \`src/report.js\`

**Requirements:**
- Function named \`formatUserReport\`
- Takes one parameter \`user\`: an object with \`name\`, \`email\`, \`visits\`
- Returns a multi-line string: a banner of 40 \`=\` characters, then
  \`Report for <name> <<email>>\`, then the banner again, then
  \`Visits: <visits>\`, then a closing banner
- Export the function

**Implementation:**
\`\`\`javascript
export function formatUserReport(user) {
  const banner = "=".repeat(40);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${user.name} <\${user.email}>\`);
  lines.push(banner);
  lines.push(\`Visits: \${user.visits}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Create \`test/report.test.js\` verifying:
- the result contains \`Report for Ada <ada@example.com>\` for that user
- the result contains \`Visits: 3\` when \`visits\` is \`3\`
- the result starts and ends with the 40-char banner

**Verification:** \`npm test\`

## Task 2: Admin Report

**File:** \`src/report.js\` (add to existing file)

**Requirements:**
- Function named \`formatAdminReport\`
- Takes one parameter \`admin\`: an object with \`name\`, \`email\`, \`lastLogin\`
- Uses a banner of 30 \`=\` characters to visually distinguish admin
  reports from user reports; the body line is \`Last login: <lastLogin>\`
- Export the function; keep \`formatUserReport\` working

**Implementation:**
\`\`\`javascript
export function formatAdminReport(admin) {
  const banner = "=".repeat(30);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${admin.name} <\${admin.email}>\`);
  lines.push(banner);
  lines.push(\`Last login: \${admin.lastLogin}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Add to \`test/report.test.js\`:
- the result contains \`Report for Grace <grace@example.com>\` for that admin
- the result contains \`Last login: 2026-06-01\`
- the result starts and ends with the 30-char banner

**Verification:** \`npm test\`
`;

// Inits a Node project whose 2-task plan's Task 2 (30-char banner) contradicts
// the Global Constraints (40-char banner); the scenario measures escalation.
export function scaffoldSddBrokenPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', BROKEN_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/report-plan.md',
    BROKEN_PLAN_BODY,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: report formatter plan'], ctx.workdir);
}

const QUALITY_PACKAGE_JSON = `{
  "name": "report-quality",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

// Same literal-backslash-n and escaped-interpolation hazards as
// BROKEN_PLAN_BODY; Task 2 duplicates Task 1's banner verbatim and mandates an
// assertion-free smoke test.
const QUALITY_PLAN_BODY = `# Report Formatter — Implementation Plan

Two report formatting functions. Implement exactly what each task
specifies.

## Task 1: User Report

**File:** \`src/report.js\`

**Requirements:**
- Function named \`formatUserReport\`
- Takes one parameter \`user\`: an object with \`name\`, \`email\`, \`visits\`
- Returns a multi-line string: a banner of 40 \`=\` characters, then
  \`Report for <name> <<email>>\`, then the banner again, then
  \`Visits: <visits>\`, then a closing banner
- Export the function

**Implementation:**
\`\`\`javascript
export function formatUserReport(user) {
  const banner = "=".repeat(40);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${user.name} <\${user.email}>\`);
  lines.push(banner);
  lines.push(\`Visits: \${user.visits}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Create \`test/report.test.js\` verifying:
- the result contains \`Report for Ada <ada@example.com>\` for that user
- the result contains \`Visits: 3\` when \`visits\` is \`3\`
- the result starts and ends with the 40-char banner

**Verification:** \`npm test\`

## Task 2: Admin Report

**File:** \`src/report.js\` (add to existing file)

**Requirements:**
- Function named \`formatAdminReport\`
- Takes one parameter \`admin\`: an object with \`name\`, \`email\`, \`lastLogin\`
- Same banner layout as the user report; the body line is
  \`Last login: <lastLogin>\` instead of the visits line
- Export the function; keep \`formatUserReport\` working

**Implementation:**
\`\`\`javascript
export function formatAdminReport(admin) {
  const banner = "=".repeat(40);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${admin.name} <\${admin.email}>\`);
  lines.push(banner);
  lines.push(\`Last login: \${admin.lastLogin}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Add to \`test/report.test.js\`:
- the result contains \`Report for Grace <grace@example.com>\` for that admin
- the result contains \`Last login: 2026-06-01\`
- the result starts and ends with the 40-char banner
- a test named \`formatAdminReport renders correctly for empty lastLogin\`
  whose body just calls \`formatAdminReport({name: "Empty", email:
  "e@example.com", lastLogin: ""})\` and asserts nothing

**Verification:** \`npm test\`
`;

export function scaffoldSddQualityDefectPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', QUALITY_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/report-plan.md',
    QUALITY_PLAN_BODY,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: report formatter plan'], ctx.workdir);
}

const YAGNI_PACKAGE_JSON = `{
  "name": "math-yagni",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

// No literal-backslash-n hazard here; the interpolation-free code blocks still
// need backtick escaping.
const YAGNI_PLAN_BODY = `# Math Module — Implementation Plan

A minimal plan for the SDD spec-compliance test. The point is YAGNI:
implement exactly what's listed, nothing more.

## Task 1: Create Add Function

Create a function that adds two numbers.

**File:** \`src/math.js\`

**Requirements:**
- Function named \`add\`
- Takes two parameters: \`a\` and \`b\`
- Returns the sum of \`a\` and \`b\`
- Export the function

**Implementation:**
\`\`\`javascript
export function add(a, b) {
  return a + b;
}
\`\`\`

**Tests:** Create \`test/math.test.js\` that verifies:
- \`add(2, 3)\` returns \`5\`
- \`add(0, 0)\` returns \`0\`
- \`add(-1, 1)\` returns \`0\`

**Verification:** \`npm test\`

## Task 2: Create Multiply Function

Create a function that multiplies two numbers.

**File:** \`src/math.js\` (add to existing file)

**Requirements:**
- Function named \`multiply\`
- Takes two parameters: \`a\` and \`b\`
- Returns the product of \`a\` and \`b\`
- Export the function
- DO NOT add any extra features (like power, divide, subtract, etc.).
  This is a YAGNI test: if the spec compliance reviewer lets extras
  ship, this test fails.

**Implementation:**
\`\`\`javascript
export function multiply(a, b) {
  return a * b;
}
\`\`\`

**Tests:** Add to \`test/math.test.js\`:
- \`multiply(2, 3)\` returns \`6\`
- \`multiply(0, 5)\` returns \`0\`
- \`multiply(-2, 3)\` returns \`-6\`

**Verification:** \`npm test\`
`;

// Inits a Node project whose Task 2 explicitly forbids over-implementation (the
// YAGNI check).
export function scaffoldSddYagniPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', YAGNI_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/math-plan.md',
    YAGNI_PLAN_BODY,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: math YAGNI plan'], ctx.workdir);
}

const SPEC_PACKAGE_JSON = `{
  "name": "priority-formatting",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const SPEC_README = `# Priority formatting fixture

Small fixture for a neutral SDD comparison scenario.
`;

// The literal backticks (\`src/priority.js\`, \`P<n> :: quartz\`, etc.) are
// escaped so they reach the file unchanged; this body carries the "quartz"
// marker the scenario asserts.
const SPEC_BODY = `# Priority Formatting Design

## Priority Rules

The module exposes three functions from \`src/priority.js\`:

- \`normalizePriority(value)\` returns an integer priority from 1 to 5.
- \`priorityLabel(value)\` returns the normalized priority as a display label.
- \`formatTicket(ticket)\` returns a compact ticket summary string.

Normalization rules:

- The strings \`urgent\` and \`later\` are accepted case-insensitively and map to
  priorities 1 and 5.
- Numeric strings and numbers from 1 through 5 map to their integer value.
- Missing, blank, unknown, or out-of-range values map to priority 3.

Display rules:

- \`priorityLabel(value)\` returns \`P<n> :: quartz\`, where \`<n>\` is the normalized
  priority.
- \`formatTicket({ id, title, priority })\` returns
  \`#<id> [<priority label>] <title>\`.
- \`formatTicket\` trims surrounding whitespace from \`id\` and \`title\`.
`;

// Cites the spec path and deliberately omits "quartz"; the literal backticks
// (\`- [ ]\`, \`npm test\`, \`src/priority.js\`, etc.) are escaped so they reach
// the file unchanged.
const SPEC_PLAN_BODY = `# Priority Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Implement the priority formatting module described by the design spec.

**Design context:** \`docs/superpowers/specs/2026-06-12-priority-design.md\`
contains the exact priority, display, and ticket formatting rules. Read that
spec before writing code or tests. Do not infer missing rules from this plan.

**Architecture:** Plain Node ESM. Create \`src/priority.js\` and
\`test/priority.test.js\`. Export the public functions from \`src/priority.js\`.

## Task 1: Priority Normalization and Labels

Implement the priority normalization and display-label functions from the spec.

**Files:**
- Create: \`src/priority.js\`
- Create: \`test/priority.test.js\`

**Steps:**
- [ ] Read the design spec's priority and display rules.
- [ ] Write failing \`node:test\` coverage for normal values, aliases, defaults,
  and the exact display suffix required by the spec.
- [ ] Run \`npm test\` and confirm the new tests fail before implementation.
- [ ] Implement \`normalizePriority(value)\` and \`priorityLabel(value)\`.
- [ ] Run \`npm test\` and confirm the tests pass.

## Task 2: Ticket Summary Formatter

Implement the ticket summary function from the spec.

**Files:**
- Modify: \`src/priority.js\`
- Modify: \`test/priority.test.js\`

**Steps:**
- [ ] Read the design spec's ticket formatting rule.
- [ ] Add failing \`node:test\` coverage for \`formatTicket(ticket)\`, including
  trimming behavior.
- [ ] Run \`npm test\` and confirm the new formatter tests fail before
  implementation.
- [ ] Implement \`formatTicket(ticket)\` and export it.
- [ ] Run \`npm test\` and confirm the full suite passes.
`;

// Inits a Node project whose plan cites a separate spec (carrying the "quartz"
// marker) rather than restating the rules; the scenario measures whether an SDD
// run preserves the cited constraints.
export function scaffoldSddSpecConstraintPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', SPEC_PACKAGE_JSON);
  writeFixtureFile(ctx.workdir, 'README.md', SPEC_README);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/specs/2026-06-12-priority-design.md',
    SPEC_BODY,
  );
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-06-12-priority.md',
    SPEC_PLAN_BODY,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: priority formatting spec and plan'],
    ctx.workdir,
  );
}

const EXPORT_PACKAGE_JSON = `{
  "name": "report-export-fixture",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const NOTES_BODY = `export function addNote(notes, text) {
  return [...notes, { text, done: false }];
}

export function searchNotes(notes, term) {
  return notes.filter((n) => n.text.includes(term));
}
`;

const NOTES_TEST_BODY = `import test from 'node:test';
import assert from 'node:assert/strict';
import { addNote, searchNotes } from '../src/notes.js';

test('addNote appends an open note', () => {
  assert.deepEqual(addNote([], 'buy milk'), [{ text: 'buy milk', done: false }]);
});

test('searchNotes filters by substring', () => {
  const notes = addNote(addNote([], 'buy milk'), 'call bank');
  assert.deepEqual(searchNotes(notes, 'bank'), [{ text: 'call bank', done: false }]);
});
`;

export const EXPORT_CSV_BODY = `export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? '')).join(','));
  }
  return lines.join('\\n');
}
`;

export const EXPORT_CSV_TEST_BODY = `import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/export-csv.js';

test('toCsv renders headers then rows', () => {
  assert.equal(
    toCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]),
    'a,b\\n1,x\\n2,y',
  );
});

test('toCsv returns empty string for empty input', () => {
  assert.equal(toCsv([]), '');
});
`;

export const REPORT_EXPORT_PLAN_BODY = `# Report Export — Implementation Plan

Two small export modules. Implement exactly what each task specifies.

## Global Constraints

- Node.js ESM project; tests run via \`npm test\` (\`node --test\`).
- Each task writes its own module AND that module's tests under \`test/\`.
- Keep \`npm test\` green after every task.

## Task 1: CSV export

**Files:** \`src/export-csv.js\`, \`test/export-csv.test.js\`

**Requirements:**
- Export a function \`toCsv(rows)\` from \`src/export-csv.js\`.
- \`toCsv\` takes an array of flat objects; returns a CSV string: header
  row from the first object's keys, then one line per row, values joined
  with commas; missing values render as the empty string.
- \`toCsv([])\` and non-array input return \`''\`.
- Write node:test coverage for the header/rows shape and the empty case.

## Task 2: JSON export

**Files:** \`src/export-json.js\`, \`test/export-json.test.js\`

**Requirements:**
- Export a function \`toJson(rows)\` from \`src/export-json.js\`.
- \`toJson\` takes an array of flat objects; returns a pretty-printed JSON
  string (two-space indent) of \`{ count, rows }\`.
- \`toJson([])\` returns the JSON for \`{ count: 0, rows: [] }\`.
- \`export-json.js\` is self-contained; **do not modify \`src/export-csv.js\`**.
- Write node:test coverage for the count/rows shape and the empty case.
`;

// Deterministic commit dates (explicit offset — TZ-dependent hashes would
// break the hardcoded blob literals in checks.sh). One timestamp per commit
// so histories are stable AND distinct.
function dateEnv(iso: string): Record<string, string> {
  return { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
}

export const STALE_LEDGER_BLOB = '318f0e1d8394ee56d3c48b31e98bdf2912ba2d2c';

export function scaffoldSddStaleForeignWorkspace(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);
  runGit(['config', 'commit.gpgsign', 'false'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', EXPORT_PACKAGE_JSON);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: project skeleton'],
    ctx.workdir,
    dateEnv('2026-07-10T12:00:00+0000'),
  );

  writeFixtureFile(ctx.workdir, 'src/notes.js', NOTES_BODY);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 1: notes module (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:01:00+0000'),
  );

  writeFixtureFile(ctx.workdir, 'test/notes.test.js', NOTES_TEST_BODY);
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 2: notes tests (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:02:00+0000'),
  );

  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-07-15-report-export.md',
    REPORT_EXPORT_PLAN_BODY,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'docs: report-export plan'],
    ctx.workdir,
    dateEnv('2026-07-10T12:03:00+0000'),
  );

  // UNTRACKED stale state — written after all commits, never added. The
  // ledger describes the finished notes plan in the pre-PR flat format
  // (no identity line) with the real short hashes of those commits.
  const shorts = runGit(['log', '--format=%h', '--abbrev=7'], ctx.workdir)
    .trim()
    .split('\n')
    .reverse(); // oldest first: [skeleton, notesTask1, notesTask2, plan]
  writeFixtureFile(ctx.workdir, '.superpowers/sdd/.gitignore', '*\n');
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/progress.md',
    `Task 1: complete (commits ${shorts[0]}..${shorts[1]}, review clean)\n` +
      `Task 2: complete (commits ${shorts[1]}..${shorts[2]}, review clean)\n`,
  );
}

export const EXPORT_CSV_BLOB = 'f5a3654f48c0a1549d1af6d55a2b9e49cd14ee33';

export function scaffoldSddSamePlanResume(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);
  runGit(['config', 'commit.gpgsign', 'false'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', EXPORT_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-07-15-report-export.md',
    REPORT_EXPORT_PLAN_BODY,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: skeleton + report-export plan'],
    ctx.workdir,
    dateEnv('2026-07-10T12:00:00+0000'),
  );

  // Task 1's real work: the interrupted session's commit, green tests.
  writeFixtureFile(ctx.workdir, 'src/export-csv.js', EXPORT_CSV_BODY);
  writeFixtureFile(
    ctx.workdir,
    'test/export-csv.test.js',
    EXPORT_CSV_TEST_BODY,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'Task 1: CSV export (SDD)'],
    ctx.workdir,
    dateEnv('2026-07-10T12:01:00+0000'),
  );

  // UNTRACKED scoped workspace, exactly as post-#1943 sdd-workspace lays
  // it out, with a truthful identity-bearing ledger (real hashes — the
  // PR's own eval discarded a fixture over fabricated ones).
  const head7 = runGit(['rev-parse', '--short=7', 'HEAD'], ctx.workdir).trim();
  const base7 = runGit(
    ['rev-parse', '--short=7', 'HEAD~1'],
    ctx.workdir,
  ).trim();
  writeFixtureFile(ctx.workdir, '.superpowers/sdd/.gitignore', '*\n');
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/2026-07-15-report-export/progress.md',
    '# SDD ledger — plan: docs/superpowers/plans/2026-07-15-report-export.md\n' +
      `Task 1: complete (commits ${base7}..${head7}, review clean)\n`,
  );
}

const MIDLOOP_PACKAGE_JSON = `{
  "name": "metrics-formatter",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

// Task 3's call contract is the variant axis: the parked variant's Task 3
// passes seconds (consistent — the open finding is quality-only), the
// structural variant's Task 3 passes milliseconds (contradicts Task 2's
// seconds contract — the open finding is a plan defect Task 3 builds on).
function midloopPlanBody(task3Arg: 'durationSeconds' | 'durationMs'): string {
  return `# Metrics Formatter — Implementation Plan

Three formatting functions for a metrics dashboard. Implement exactly what
each task specifies.

## Global Constraints

- Node.js ESM project; tests run via \`npm test\` (\`node --test\`).
- Every function is exported from its own file under \`src/\`.

## Task 1: Count Formatter

**File:** \`src/count.js\`

**Requirements:**
- Function named \`formatCount\`
- Takes one parameter \`n\`: a non-negative integer
- Returns \`<n>\` with thousands separated by commas (e.g. \`12,345\`)
- Export the function

**Tests:** Create \`test/count.test.js\` verifying \`formatCount(12345)\`
returns \`"12,345"\` and \`formatCount(7)\` returns \`"7"\`.

**Verification:** \`npm test\`

## Task 2: Duration Formatter

**File:** \`src/duration.js\`

**Requirements:**
- Function named \`formatDuration\`
- Call contract: \`formatDuration(seconds)\`
- Takes one parameter \`seconds\`: a non-negative integer count of seconds
- Returns \`H:MM:SS\` when hours > 0, else \`M:SS\`
- Export the function

**Tests:** Create \`test/duration.test.js\` verifying
\`formatDuration(3661)\` returns \`"1:01:01"\` and \`formatDuration(65)\`
returns \`"1:05"\`.

**Verification:** \`npm test\`

## Task 3: Summary Line

**File:** \`src/summary.js\`

**Requirements:**
- Function named \`summarize\`
- Takes one parameter \`metrics\`: an object with \`events\` (integer) and
  \`${task3Arg}\` (integer)
- Returns \`<formatted events> events in <formatted duration>\`, using
  \`formatCount\` for the events and \`formatDuration(metrics.${task3Arg})\`
  for the duration
- Export the function

**Tests:** Create \`test/summary.test.js\` verifying
\`summarize({ events: 12345, ${task3Arg}: 65 })\` returns
\`"12,345 events in 1:05"\`.

**Verification:** \`npm test\`
`;
}

const MIDLOOP_COUNT_JS = `export function formatCount(n) {
  return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
}
`;

// The seeded Important finding: the pad-and-join expression appears three
// times. Behavior is correct (tests pass); the finding is quality-only.
const MIDLOOP_DURATION_JS = `export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  if (m > 0) {
    return m + ":" + String(s).padStart(2, "0");
  }
  return "0:" + String(s).padStart(2, "0");
}
`;

const MIDLOOP_COUNT_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCount } from "../src/count.js";

test("formatCount separates thousands", () => {
  assert.equal(formatCount(12345), "12,345");
});

test("formatCount leaves small numbers alone", () => {
  assert.equal(formatCount(7), "7");
});
`;

const MIDLOOP_DURATION_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/duration.js";

test("formatDuration formats hours", () => {
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatDuration formats minutes", () => {
  assert.equal(formatDuration(65), "1:05");
});
`;

// One fix-round's ledger accounting. `applyChange` defaults to the
// whitespace-grade churn that keeps rounds honest commits without resolving
// anything; pass it to make a round a real fix (e.g. the round-3 escalation
// drill's one genuinely addressed finding). `resolvedFinding` names what
// that real fix addressed, for the report appendix's note — kept as round
// data rather than hardcoded prose in the shared report builder.
interface FixRound {
  readonly addressed: number;
  readonly open: number;
  readonly finding: string;
  readonly resolvedFinding?: string;
  readonly applyChange?: (workdir: string) => void;
}

interface MidloopOptions {
  task3Arg: 'durationSeconds' | 'durationMs';
  openFinding: string;
  // Overrides the default five all-unresolved rounds (used by the round-3
  // escalation drill, which stops the loop early with one round addressed).
  rounds?: FixRound[];
  // When set, records Task 2's stuck implementer's model tier in both the
  // ledger and the task-2 report — the escalation drill's fixed point for
  // checking that a resuming controller actually escalates past it.
  implementerModel?: string;
}

function defaultRoundChurn(round: number): (workdir: string) => void {
  return (workdir: string): void =>
    writeFixtureFile(
      workdir,
      'src/duration.js',
      `${MIDLOOP_DURATION_JS}// fix round ${round}: reviewed, expression retained\n`,
    );
}

function buildTask2Report(
  rounds: FixRound[],
  implementerModel: string | undefined,
): string {
  const n = rounds.length;
  const finalRound = rounds[n - 1];
  if (finalRound === undefined) {
    throw new Error('scaffoldSddMidloop requires at least one fix round');
  }
  const modelLine = implementerModel
    ? `Implementer model: ${implementerModel} (cheapest tier).\n\n`
    : '';
  const addressedNote =
    finalRound.addressed > 0 && finalRound.resolvedFinding
      ? `Round ${n} addressed: ${finalRound.resolvedFinding}.\n\n`
      : '';
  // The appendix body below is byte-identical, for n=5 with no addressed
  // note, to the pre-parameterization text scaffoldSddMidloopParked/
  // Structural shipped with — do not reflow it further.
  return `# Task 2 Report

${modelLine}Implemented formatDuration per brief. Tests: test/duration.test.js, 2/2
passing via \`npm test\`, output pristine.

## Fix round appendix

${addressedNote}Rounds 1-${n} attempted the open review finding below; each re-review returned
NOT ADDRESSED:

- ${finalRound.finding}
`;
}

// Builds a repo mid-SDD-execution: Task 1 complete, Task 2 at a fix round
// (5/5 by default; the round-3 escalation drill stops earlier) with one open
// finding, Task 3 unstarted. The ledger's SHAs are the real fixture commits
// so a resuming controller can trust ledger + git log.
function scaffoldSddMidloop(ctx: HelperContext, opts: MidloopOptions): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', MIDLOOP_PACKAGE_JSON);
  writeFixtureFile(ctx.workdir, '.gitignore', '.superpowers/\n');
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/metrics-plan.md',
    midloopPlanBody(opts.task3Arg),
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: metrics formatter plan'], ctx.workdir);
  const base = shortHead(ctx.workdir);

  writeFixtureFile(ctx.workdir, 'src/count.js', MIDLOOP_COUNT_JS);
  writeFixtureFile(ctx.workdir, 'test/count.test.js', MIDLOOP_COUNT_TEST);
  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'Task 1: formatCount with tests'], ctx.workdir);
  const task1Head = shortHead(ctx.workdir);

  writeFixtureFile(ctx.workdir, 'src/duration.js', MIDLOOP_DURATION_JS);
  writeFixtureFile(ctx.workdir, 'test/duration.test.js', MIDLOOP_DURATION_TEST);
  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'Task 2: formatDuration with tests'], ctx.workdir);
  const task2Base = task1Head;
  const task2Head = shortHead(ctx.workdir);
  let prev = task2Head;

  // Fix-round commits (five by default) that never resolve the finding
  // (whitespace-grade churn keeps them honest commits without changing
  // behavior), unless a round supplies its own `applyChange`.
  const rounds: FixRound[] =
    opts.rounds ??
    Array.from({ length: 5 }, () => ({
      addressed: 0,
      open: 1,
      finding: opts.openFinding,
    }));
  const roundLines: string[] = [];
  for (const [i, spec] of rounds.entries()) {
    const round = i + 1;
    const applyChange = spec.applyChange ?? defaultRoundChurn(round);
    applyChange(ctx.workdir);
    runGit(['add', '-A'], ctx.workdir);
    runGit(['commit', '-m', `Task 2 fix round ${round}`], ctx.workdir);
    const head = shortHead(ctx.workdir);
    roundLines.push(
      `Task 2: fix round ${round}/5 (${spec.addressed} addressed, ${spec.open} open — ${spec.finding}; commits ${prev}..${head})`,
    );
    prev = head;
  }

  const ledgerLines = [
    '# SDD Progress Ledger',
    'Plan: docs/superpowers/plans/metrics-plan.md',
    `Task 1: complete (commits ${base}..${task1Head}, review clean)`,
    `Task 2: implementer DONE (commits ${task2Base}..${task2Head})`,
  ];
  if (opts.implementerModel) {
    ledgerLines.push(
      `Task 2 implementer model: ${opts.implementerModel} (cheapest tier)`,
    );
  }
  ledgerLines.push(...roundLines, '');
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/progress.md',
    ledgerLines.join('\n'),
  );

  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/task-2-report.md',
    buildTask2Report(rounds, opts.implementerModel),
  );
}

function shortHead(workdir: string): string {
  return runGit(['rev-parse', '--short=7', 'HEAD'], workdir).trim();
}

const RESUME_PACKAGE_JSON = `{
  "name": "report-resume",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

// The planted defect: Task 2's Requirements prose mandates a trailing
// newline that the implementation snippet omits and the mandated tests do
// not cover. A spec-compliance review against the brief must flag it as
// Missing, forcing a fix cycle — the resume-vs-fix-subagent mechanism under
// test. Same literal-backslash-n and escaped-interpolation hazards as the
// sibling plan bodies.
const RESUME_PLAN_BODY = `# Report Formatter — Implementation Plan

Two report formatting functions. Implement exactly what each task
specifies.

## Task 1: User Report

**File:** \`src/report.js\`

**Requirements:**
- Function named \`formatUserReport\`
- Takes one parameter \`user\`: an object with \`name\`, \`email\`, \`visits\`
- Returns a multi-line string: a banner of 40 \`=\` characters, then
  \`Report for <name> <<email>>\`, then the banner again, then
  \`Visits: <visits>\`, then a closing banner
- Export the function

**Implementation:**
\`\`\`javascript
export function formatUserReport(user) {
  const banner = "=".repeat(40);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${user.name} <\${user.email}>\`);
  lines.push(banner);
  lines.push(\`Visits: \${user.visits}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Create \`test/report.test.js\` verifying:
- the result contains \`Report for Ada <ada@example.com>\` for that user
- the result contains \`Visits: 3\` when \`visits\` is \`3\`

**Verification:** \`npm test\`

## Task 2: Admin Report

**File:** \`src/report.js\` (add to existing file)

**Requirements:**
- Function named \`formatAdminReport\`
- Takes one parameter \`admin\`: an object with \`name\`, \`email\`, \`lastLogin\`
- Same banner layout as the user report; the body line is
  \`Last login: <lastLogin>\` instead of the visits line
- The returned string ends with a single trailing newline after the
  closing banner — report consumers concatenate admin reports
  back-to-back and rely on it
- Export the function; keep \`formatUserReport\` working

**Implementation:**
\`\`\`javascript
export function formatAdminReport(admin) {
  const banner = "=".repeat(40);
  const lines = [];
  lines.push(banner);
  lines.push(\`Report for \${admin.name} <\${admin.email}>\`);
  lines.push(banner);
  lines.push(\`Last login: \${admin.lastLogin}\`);
  lines.push(banner);
  return lines.join("\\n");
}
\`\`\`

**Tests:** Add to \`test/report.test.js\`:
- the result contains \`Report for Grace <grace@example.com>\` for that admin
- the result contains \`Last login: 2026-06-01\`

**Verification:** \`npm test\`
`;

export function scaffoldSddResumeTriggerPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'package.json', RESUME_PACKAGE_JSON);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/report-plan.md',
    RESUME_PLAN_BODY,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: report formatter plan'], ctx.workdir);
}

// Shared with scaffoldSddTasksDoneFinalPending, whose Task 2 has already
// been through this exact breaker-and-park cycle.
export const MIDLOOP_PADSTART_FINDING =
  'Important: formatDuration repeats the String(...).padStart(2, "0") formatting expression in three branches — extract it';

// Non-load-bearing open finding: quality-only, nothing downstream consumes
// formatDuration's internals. The breaker should park it and continue.
export function scaffoldSddMidloopParked(ctx: HelperContext): void {
  scaffoldSddMidloop(ctx, {
    task3Arg: 'durationSeconds',
    openFinding: MIDLOOP_PADSTART_FINDING,
  });
}

// Plan-neutral by construction: the seeded plan's Task 2 section is
// verbatim-silent on formatDuration's internals — it states only the call
// contract (`formatDuration(seconds)`), the non-negative-integer parameter,
// the H:MM:SS/M:SS output shape, and two test cases. It says nothing about
// named constants, so this finding cannot trigger SKILL.md's
// plan-mandated-conflict carve-out the way an input-validation finding did
// (that finding contradicted the plan's own "non-negative integer" contract
// and got legitimately dropped pre-loop in local iteration — see
// task-14-report.md). The magic numbers are real: 3600 and 60 appear
// unnamed in MIDLOOP_DURATION_JS below.
const ROUND1_MAGIC_NUMBERS_FINDING =
  'magic numbers 3600 and 60 in formatDuration lack named constants';
const ROUND1_REPEATED_EXPRESSION_FINDING = 'repeated formatting expression';
const ROUND1_RESOLVED_FINDING =
  'missing boundary test for exactly one hour (3600 seconds) in test/duration.test.js';

const MIDLOOP_DURATION_TEST_WITH_HOUR_BOUNDARY_CASE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/duration.js";

test("formatDuration formats hours", () => {
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatDuration formats minutes", () => {
  assert.equal(formatDuration(65), "1:05");
});

test("formatDuration formats an exact one-hour boundary", () => {
  assert.equal(formatDuration(3600), "1:00:00");
});
`;

// Fix-loop resume drill (round 1 → round 2): Task 2's original review found
// three findings; round 1 (the original cheap-tier implementer,
// claude-haiku-4-5) genuinely resolves one (adds the missing hour-boundary
// test) while the other two — unnamed magic numbers and the triplicated
// formatting expression, both pure code-quality and plan-neutral — stay
// open. Stops at round 1/5, inside SKILL.md's "Rounds 1-3 — resume the
// original implementer" range, so a resuming controller must dispatch
// round 2 on the SAME implementer (no escalation; R<4) and scope the
// re-review to exactly the two still-open findings.
export function scaffoldSddMidloopRound1(ctx: HelperContext): void {
  scaffoldSddMidloop(ctx, {
    task3Arg: 'durationSeconds',
    openFinding: ROUND1_REPEATED_EXPRESSION_FINDING,
    implementerModel: 'claude-haiku-4-5',
    rounds: [
      {
        addressed: 1,
        open: 2,
        finding: `${ROUND1_MAGIC_NUMBERS_FINDING}; ${ROUND1_REPEATED_EXPRESSION_FINDING}`,
        resolvedFinding: ROUND1_RESOLVED_FINDING,
        applyChange: (workdir: string): void =>
          writeFixtureFile(
            workdir,
            'test/duration.test.js',
            MIDLOOP_DURATION_TEST_WITH_HOUR_BOUNDARY_CASE,
          ),
      },
    ],
  });
}

const MIDLOOP_DURATION_TEST_WITH_ZERO_CASE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/duration.js";

test("formatDuration formats hours", () => {
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatDuration formats minutes", () => {
  assert.equal(formatDuration(65), "1:05");
});

test("formatDuration formats zero seconds", () => {
  assert.equal(formatDuration(0), "0:00");
});
`;

const ROUND3_STUCK_FINDING = 'repeated formatting expression in formatDuration';
const ROUND3_RESOLVED_FINDING =
  'missing zero-seconds edge case test in test/duration.test.js';

// Fix-loop escalation drill: Task 2 stalls for two unresolved rounds under a
// cheap-tier implementer (claude-haiku-4-5), then round 3 genuinely resolves
// one of its two open findings (adds the zero-seconds test) while the other
// — the formatting-expression finding — stays open. Stops at round 3/5 so a
// resuming controller must dispatch round 4 itself, on a fresh implementer
// at least one tier above the recorded stuck one (SKILL.md Model Selection:
// "Fix-loop escalation (rounds 4-5): use a model at least one tier above the
// implementer that got stuck").
export function scaffoldSddMidloopRound3(ctx: HelperContext): void {
  scaffoldSddMidloop(ctx, {
    task3Arg: 'durationSeconds',
    openFinding: ROUND3_STUCK_FINDING,
    implementerModel: 'claude-haiku-4-5',
    rounds: [
      {
        addressed: 0,
        open: 2,
        finding: `${ROUND3_STUCK_FINDING}; ${ROUND3_RESOLVED_FINDING}`,
      },
      {
        addressed: 0,
        open: 2,
        finding: `${ROUND3_STUCK_FINDING}; ${ROUND3_RESOLVED_FINDING}`,
      },
      {
        addressed: 1,
        open: 1,
        finding: ROUND3_STUCK_FINDING,
        resolvedFinding: ROUND3_RESOLVED_FINDING,
        applyChange: (workdir: string): void =>
          writeFixtureFile(
            workdir,
            'test/duration.test.js',
            MIDLOOP_DURATION_TEST_WITH_ZERO_CASE,
          ),
      },
    ],
  });
}

// Load-bearing open finding: the plan's Task 3 passes milliseconds into a
// seconds contract. The breaker should stop via BLOCKED, not park.
export function scaffoldSddMidloopStructural(ctx: HelperContext): void {
  scaffoldSddMidloop(ctx, {
    task3Arg: 'durationMs',
    openFinding:
      'Important: plan contradiction — Task 3 passes milliseconds (durationMs) into formatDuration, whose brief defines seconds; unresolvable within Task 2',
  });
}

const TASKS_DONE_PARKED_RULING =
  'quality-only — nothing downstream depends on formatDuration internals; real but not load-bearing';

// Undiscovered quality wart for the final whole-branch review to find:
// Task 3's own task review missed that the zero-events branch is byte-for-
// byte identical to the fallthrough — dead branching, not a correctness
// bug (both paths return the same string), so it never showed up as a test
// failure.
const TASKS_DONE_SUMMARY_JS = `import { formatCount } from './count.js';
import { formatDuration } from './duration.js';

export function summarize(metrics) {
  if (metrics.events === 0) {
    return formatCount(metrics.events) + " events in " + formatDuration(metrics.durationSeconds);
  }
  return formatCount(metrics.events) + " events in " + formatDuration(metrics.durationSeconds);
}
`;

const TASKS_DONE_SUMMARY_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/summary.js";

test("summarize combines formatted count and duration", () => {
  assert.equal(
    summarize({ events: 12345, durationSeconds: 65 }),
    "12,345 events in 1:05",
  );
});
`;

// Returns the short (7-char) hash of the most recent commit whose message
// contains `subject` verbatim — used to recover a fixture's own earlier
// commit boundaries without threading extra return values through
// scaffoldSddMidloop.
function commitFor(workdir: string, subject: string): string {
  return runGit(
    [
      'log',
      '--format=%h',
      '--abbrev=7',
      '--fixed-strings',
      `--grep=${subject}`,
      '-1',
    ],
    workdir,
  ).trim();
}

// Final-review probe base: all three tasks already complete. Task 2's fix
// loop tripped the breaker exactly as scaffoldSddMidloopParked's does, but
// this fixture picks up one step further along — the open finding is
// already adjudicated (parked with a ruling) and Task 2 is marked
// complete, matching the outcome sdd-breaker-adjudicates-at-cap's live run
// produces. Two further warts sit undiscovered in the completed code (the
// formatDuration input-guard gap already present in MIDLOOP_DURATION_JS,
// unchanged, plus the dead branch in summarize above) for the final
// whole-branch review to find fresh — the parked finding alone would give
// that review nothing new to do. No final-review ledger marker of any
// kind: SKILL.md's Final Review section defines no ledger vocabulary for
// "final review ran/complete" (its own adjudication vocabulary reuses the
// per-task `Task <N>: parked —`/`Task <N>: BLOCKED —` lines), so none is
// seeded here — see task-13-report.md.
export function scaffoldSddTasksDoneFinalPending(ctx: HelperContext): void {
  scaffoldSddMidloop(ctx, {
    task3Arg: 'durationSeconds',
    openFinding: MIDLOOP_PADSTART_FINDING,
  });

  const task1Head = commitFor(ctx.workdir, 'Task 1: formatCount with tests');
  const task2Base = task1Head;
  const task2FinalHead = shortHead(ctx.workdir);

  writeFixtureFile(ctx.workdir, 'src/summary.js', TASKS_DONE_SUMMARY_JS);
  writeFixtureFile(
    ctx.workdir,
    'test/summary.test.js',
    TASKS_DONE_SUMMARY_TEST,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'Task 3: summarize with tests'], ctx.workdir);
  const task3Head = shortHead(ctx.workdir);

  const existingLedger = readFileSync(
    join(ctx.workdir, '.superpowers/sdd/progress.md'),
    'utf8',
  );
  const newLines = [
    `Task 2: parked — ${MIDLOOP_PADSTART_FINDING} — ruling: ${TASKS_DONE_PARKED_RULING}`,
    `Task 2: complete (commits ${task2Base}..${task2FinalHead}, 1 parked)`,
    `Task 3: complete (commits ${task2FinalHead}..${task3Head}, review clean)`,
  ];
  writeFixtureFile(
    ctx.workdir,
    '.superpowers/sdd/progress.md',
    `${existingLedger}${newLines.join('\n')}\n`,
  );
}

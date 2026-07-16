// SDD-fixture helpers. Five embedded-body helpers (auth/broken/quality/yagni/
// spec-constraint) write their plan bodies inline. The PLAN_BODY constants carry
// literal backslash-n sequences and literal ${...} interpolations that must reach
// the file unchanged. (Per-scenario file fixtures now live under
// scenarios/<name>/fixtures/ and are read by init_repo_from_fixtures.)
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

// SDD-fixture helpers. The nine scaffoldSdd* fixture-reading helpers copy
// design.md + plan.md out of fixtures/ and commit a clean-slate repo; the five
// embedded-body helpers (auth/broken/quality/yagni/spec-constraint) write their
// plan bodies inline. The PLAN_BODY constants carry literal backslash-n
// sequences and literal ${...} interpolations that must reach the file
// unchanged.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../paths.ts';
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';

const FIXTURES_DIR = join(repoRoot(), 'fixtures');

// Shared scaffold for the nine sdd-* fixture-reading helpers. Inits a clean
// repo, copies design.md + plan.md from fixtures/<fixtureName>, then `git add -A`
// and a single "initial: design + plan" commit.
function scaffoldFromFixture(workdir: string, fixtureName: string): void {
  ensureWorkdir(workdir);
  runGit(['init', '-b', 'main'], workdir);
  runGit(['config', 'user.email', 'drill@test.local'], workdir);
  runGit(['config', 'user.name', 'Drill Test'], workdir);

  const src = join(FIXTURES_DIR, fixtureName);
  for (const name of ['design.md', 'plan.md']) {
    copyFileSync(join(src, name), join(workdir, name));
  }

  runGit(['add', '-A'], workdir);
  runGit(['commit', '-m', 'initial: design + plan'], workdir);
}

export function scaffoldSddGoFractals(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals');
}

export function scaffoldSddGoFractalsCrisp(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-crisp');
}

export function scaffoldSddGoFractalsCriticalPlan(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-critical-plan');
}

export function scaffoldSddGoFractalsStripped(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-stripped');
}

export function scaffoldSddGoFractalsCoarse(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-coarse');
}

export function scaffoldSddGoFractalsElicited(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-elicited');
}

export function scaffoldSddGoFractalsControlPlan(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-go-fractals-control-plan');
}

export function scaffoldSddSvelteTodo(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-svelte-todo');
}

export function scaffoldSddSvelteTodoElicited(ctx: HelperContext): void {
  scaffoldFromFixture(ctx.workdir, 'sdd-svelte-todo-elicited');
}

// The trivial auth-system stub plan.
const AUTH_PLAN_BODY = `# Auth System Implementation Plan

A short stub plan used by the explicit-skill-request and
mid-conversation-skill-invocation drill scenarios.

## Task 1: Add User model

**File:** \`src/models/User.js\`

Export a \`User\` class with an \`email\` field and a \`passwordHash\` field.
Add a one-line test in \`test/models/User.test.js\` asserting the class is
constructable with \`{ email, passwordHash }\`.

## Task 2: Add register/login routes

**File:** \`src/routes/auth.js\`

Export Express-style handlers \`register(req, res)\` and \`login(req, res)\`.
Stubs are fine — return JSON \`{ ok: true }\` from each.

## Task 3: Add JWT middleware

**File:** \`src/middleware/jwt.js\`

Export \`requireJWT(req, res, next)\`. If no \`Authorization\` header,
respond \`401\`. Otherwise call \`next()\`.

## Task 4: Wire it up

**File:** \`src/index.js\`

Import the routes and middleware. Wire the routes to \`/auth/*\` paths
and apply \`requireJWT\` to a placeholder \`/protected\` route.

The plan is intentionally tiny; the scenarios only measure whether the
SDD skill loads and starts dispatching subagents in response to the
user's request, not whether the implementation completes.
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

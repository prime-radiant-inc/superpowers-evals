// src/setup-helpers/triggering-fixtures.ts
// Triggering-fixture helpers ported from triggering_executing_plans.py and
// triggering_writing_plans.py. addStubExecutingPlan layers a stub plan commit
// onto an existing repo (no init); createWritingPlansSkeleton is a
// self-contained Express skeleton (does its own git init). Embedded source
// constants are ported verbatim from the corresponding Python module.
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';

// Verbatim from triggering_executing_plans.py:PLAN_BODY.
const PLAN_BODY = `# 2024-01-15 Auth System Implementation Plan

A short stub plan used by the triggering-executing-plans drill scenario.

## Task 1: Add a no-op auth placeholder

**File:** \`src/auth.js\`

Create a module that exports a single function \`placeholder()\` returning the
string \`"auth-placeholder"\`. Add a one-line test in \`test/auth.test.js\`.

## Task 2: Wire the placeholder into the entry point

**File:** \`src/index.js\`

Import \`placeholder\` from \`./auth.js\` and log its return value at startup.

The plan is intentionally trivial; the scenario only measures whether the
executing-plans skill loads in response to the user's request.
`;

// Port of triggering_executing_plans.py:add_stub_executing_plan. No init; writes
// the stub plan and commits it (scoped `git add docs`) onto an existing repo.
export function addStubExecutingPlan(ctx: HelperContext): void {
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2024-01-15-auth-system.md',
    PLAN_BODY,
  );
  runGit(['add', 'docs'], ctx.workdir);
  runGit(['commit', '-m', 'add stub auth plan'], ctx.workdir);
}

// Verbatim from triggering_writing_plans.py:APP_JS.
const APP_JS = `import express from "express";

const app = express();
app.use(express.json());

// In-memory user store. No database — this app keeps users in memory.
const users = [];

// Existing route, shows the pattern routes follow in this app.
app.get("/health", (_req, res) => {
  res.json({ ok: true, users: users.length });
});

app.listen(3000, () => {
  console.log("auth-skeleton listening on http://localhost:3000");
});
`;

// Verbatim from triggering_writing_plans.py:PACKAGE_JSON. Written as a raw
// string (2-space formatting / key order preserved); not JSON.stringify'd.
const PACKAGE_JSON = `{
  "name": "auth-skeleton",
  "version": "0.1.0",
  "type": "module",
  "description": "Minimal Express app with an in-memory user store.",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "express": "^4.19.0"
  }
}
`;

// Port of triggering_writing_plans.py:create_writing_plans_skeleton. A
// self-contained Express skeleton (own git init + config); `git add -A`.
export function createWritingPlansSkeleton(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'app.js', APP_JS);
  writeFixtureFile(ctx.workdir, 'package.json', PACKAGE_JSON);

  runGit(['add', '-A'], ctx.workdir);
  runGit(
    ['commit', '-m', 'initial: express app with in-memory user store'],
    ctx.workdir,
  );
}

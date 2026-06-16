// Triggering-fixture helpers. addAuthExecutionPlan layers a concrete plan commit
// onto an existing repo (no init); createWritingPlansSkeleton is a
// self-contained Express skeleton (does its own git init).
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';

const PLAN_BODY = `# 2024-01-15 Auth System Implementation Plan

A compact plan used by the triggering-executing-plans drill scenario.

## Task 1: Add Bearer token parsing

**Files:**

- \`package.json\`
- \`src/authToken.js\`
- \`test/authToken.test.js\`

Add a \`test\` script to \`package.json\`:

\`\`\`json
"scripts": {
  "test": "node --test"
}
\`\`\`

Create \`src/authToken.js\` exporting \`parseAuthToken(header)\`. It should return
the token string for \`Authorization: Bearer <token>\`, trimming surrounding
spaces around the token. It should return \`null\` for a missing header, a
non-string header, a non-Bearer scheme, or an empty token.

Create \`test/authToken.test.js\` with node:test coverage for:

- valid Bearer token returns the token
- empty Bearer token returns \`null\`
- Basic auth returns \`null\`
- missing header returns \`null\`

Run \`npm test\` and keep it passing.

## Task 2: Use the parser from the entry point

**File:** \`src/index.js\`

Import \`parseAuthToken\` from \`./authToken.js\`. Update \`main()\` so it checks
\`process.env.AUTHORIZATION\`, prints \`authenticated\` when a token is present,
and prints \`anonymous\` otherwise. Keep the existing greeting output.

Run \`npm test\` after the change.
`;

// No init; writes the plan and commits it (scoped `git add docs`) onto an
// existing repo.
export function addAuthExecutionPlan(ctx: HelperContext): void {
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2024-01-15-auth-system.md',
    PLAN_BODY,
  );
  runGit(['add', 'docs'], ctx.workdir);
  runGit(['commit', '-m', 'add auth execution plan'], ctx.workdir);
}

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

// Written as a raw string (2-space formatting / key order preserved); not
// JSON.stringify'd.
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

// A self-contained Express skeleton (own git init + config); `git add -A`.
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

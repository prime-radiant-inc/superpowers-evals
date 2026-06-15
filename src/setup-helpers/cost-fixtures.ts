// Cost-fixture helpers: cost_checkbox_page, cost_clean_repo, cost_large_files,
// and cost_trivial_plan. The large-files generator (renderModule) must emit
// exact bytes — that fixture IS the token-bloat measurement — so the literal
// ${id} stays escaped and the comment/throw shape is exact.
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tasks</title>
  </head>
  <body>
    <h1>Tasks</h1>
    <main></main>
  </body>
</html>
`;

// Single-page fixture with an empty <main>; scoped `git add index.html`.
export function createCostCheckboxPage(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);
  writeFixtureFile(ctx.workdir, 'index.html', PAGE);
  runGit(['add', 'index.html'], ctx.workdir);
  runGit(['commit', '-m', 'initial: empty tasks page'], ctx.workdir);
}

const README = `# habits

A small CLI for tracking habits.

This is intentionally a sketch - there's no implementation yet.
`;

// Clean repo with a vague README; scoped `git add README.md`.
export function createCostCleanRepo(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);
  writeFixtureFile(ctx.workdir, 'README.md', README);
  runGit(['add', 'README.md'], ctx.workdir);
  runGit(['commit', '-m', 'initial: README'], ctx.workdir);
}

const APP_JS = `function main() {
  return 0;
}

main();
`;

const PLAN = `# 2026-05-06 Trivial single-line change

A one-task plan used by the cost-trivial-task-review-fanout drill scenario.
The task is intentionally trivial; the cost question is whether the
executing-plans / SDD path fans out into multiple review subagents
disproportionate to the change.

## Task 1: Log app start

**File:** \`src/app.js\`

Add the line \`console.log('app started');\` as the very first line of
\`src/app.js\`, before the existing \`function main()\` declaration.

That's the entire change.
`;

// App stub + dated plan; `git add -A`.
export function createCostTrivialPlan(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  writeFixtureFile(ctx.workdir, 'src/app.js', APP_JS);
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/plans/2026-05-06-trivial.md',
    PLAN,
  );

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: app stub + trivial plan'], ctx.workdir);
}

// The synthetic CRUD modules, as (module name, entity name) pairs.
const MODULES: ReadonlyArray<readonly [string, string]> = [
  ['users', 'User'],
  ['orders', 'Order'],
  ['invoices', 'Invoice'],
  ['inventory', 'Item'],
  ['notifications', 'Notification'],
];

const ENTITIES_PER_MODULE = 80;

// Render one synthetic CRUD module. The header is 4 comment lines + blank +
// `const <module> = new Map();` + blank; each entity emits a get/save block. The
// literal ${id} in the throw is escaped (\${id}) so it lands in the file
// verbatim, not host-interpolated.
function renderModule(module: string, entity: string): string {
  const header =
    `// ${module}.js\n` +
    `// Auto-generated CRUD helpers for ${entity} records.\n` +
    `// This module is intentionally repetitive; agents inspecting it\n` +
    `// should grep for specific concerns rather than read it whole.\n` +
    '\n' +
    `const ${module} = new Map();\n` +
    '\n';

  const blocks: string[] = [];
  for (let i = 1; i <= ENTITIES_PER_MODULE; i++) {
    blocks.push(
      `export function get${entity}${i}(id) {\n` +
        `  // Lookup helper #${i} for ${entity} records.\n` +
        `  const record = ${module}.get(id);\n` +
        '  if (!record) {\n' +
        `    throw new Error(\`${entity} ${i} not found: \${id}\`);\n` +
        '  }\n' +
        '  return record;\n' +
        '}\n' +
        '\n' +
        `export function save${entity}${i}(id, data) {\n` +
        `  // Persist helper #${i} for ${entity} records.\n` +
        `  ${module}.set(id, { ...data, version: ${i} });\n` +
        `  return ${module}.get(id);\n` +
        '}\n' +
        '\n',
    );
  }
  return header + blocks.join('');
}

// Writes the 5 synthetic CRUD modules to src/<module>.js; `git add -A`.
export function createCostLargeFiles(ctx: HelperContext): void {
  ensureWorkdir(ctx.workdir);
  runGit(['init', '-b', 'main'], ctx.workdir);
  runGit(['config', 'user.email', 'drill@test.local'], ctx.workdir);
  runGit(['config', 'user.name', 'Drill Test'], ctx.workdir);

  for (const [module, entity] of MODULES) {
    writeFixtureFile(
      ctx.workdir,
      `src/${module}.js`,
      renderModule(module, entity),
    );
  }

  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'initial: synthetic CRUD modules'], ctx.workdir);
}

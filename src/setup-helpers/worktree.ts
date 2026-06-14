// src/setup-helpers/worktree.ts
// Tier-1 worktree helpers ported from worktree.py (the non-codex/non-gemini
// functions) and worktree_pressure.py. addWorktree/detachHead are library
// functions (not dispatchable); the rest are HelperContext helpers. The
// CALLER_CONSENT_PLAN constant is ported verbatim. Tier-2 helpers
// (linkGeminiExtension, installCodexSuperpowersPluginHooks) are added in
// Tasks 12-13.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { HelperContext } from './context.ts';
import { writeFixtureFile } from './fs.ts';
import { runGit, runGitAllowFail } from './git.ts';

// Verbatim from worktree.py:CALLER_CONSENT_PLAN.
const CALLER_CONSENT_PLAN = `# Custom Greeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a small greeting customization feature to the Node fixture.

---

### Task 1: Custom greeting

**Files:**
- Modify: \`src/index.js\`
- Modify: \`src/utils.js\`
- Create: \`tests/greeting.test.js\`

**Acceptance Criteria:**
- The app can greet a provided name instead of always greeting \`world\`.
- The default behavior remains \`Hello, world!\`.
- A test covers both the default and custom-name paths.

- [ ] **Step 1: Add tests for default and custom greetings.**
- [ ] **Step 2: Update the greeting implementation.**
- [ ] **Step 3: Run the relevant tests.**
`;

// Port of worktree.py:_sibling_path. Returns <workdir.parent>/<workdir.name>-<suffix>.
function siblingPath(workdir: string, suffix: string): string {
  return join(dirname(workdir), `${basename(workdir)}-${suffix}`);
}

// Library (not dispatchable). Port of worktree.py:add_worktree. Python uses a
// bare subprocess.run without the identity env here; reusing runGit is
// intentional — the identity env is inert for non-committing git ops, so the
// output is identical.
export function addWorktree(
  repoDir: string,
  branch: string,
  worktreePath: string,
): void {
  runGit(['worktree', 'add', '-b', branch, worktreePath], repoDir);
}

// Library (not dispatchable). Port of worktree.py:detach_head. The final
// `git branch -D` is run unchecked in Python (a stale branch is acceptable), so
// it goes through the non-throwing variant.
export function detachHead(worktreePath: string): void {
  const commit = runGit(['rev-parse', 'HEAD'], worktreePath).trim();
  const branch = runGit(['branch', '--show-current'], worktreePath).trim();
  runGit(['checkout', '--detach', commit], worktreePath);
  if (branch) {
    runGitAllowFail(['branch', '-D', branch], worktreePath);
  }
}

// Port of worktree.py:add_existing_worktree. Creates an existing worktree (for
// 'already inside' scenarios).
export function addExistingWorktree(ctx: HelperContext): void {
  addWorktree(
    ctx.workdir,
    'existing-feature',
    siblingPath(ctx.workdir, 'existing-worktree'),
  );
}

// Port of worktree.py:detach_worktree_head. Detaches HEAD in the existing
// worktree.
export function detachWorktreeHead(ctx: HelperContext): void {
  detachHead(siblingPath(ctx.workdir, 'existing-worktree'));
}

// Port of worktree.py:symlink_superpowers. Creates <workdir>/.agents/skills and
// symlinks superpowers -> <superpowersRoot>/skills. Does not stat the target.
export function symlinkSuperpowers(ctx: HelperContext): void {
  if (ctx.superpowersRoot === undefined) {
    throw new Error('superpowersRoot is required for symlink_superpowers');
  }
  const skillsDir = join(ctx.workdir, '.agents', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const target = join(ctx.superpowersRoot, 'skills');
  const link = join(skillsDir, 'superpowers');
  symlinkSync(target, link);
}

// Port of worktree.py:link_gemini_extension. Links superpowers as a Gemini CLI
// extension and injects project context. Extensions are global, but GEMINI.md
// context loading is project-scoped, so the temp workdir needs a GEMINI.md with
// absolute @imports. The extension name defaults to 'superpowers'; only if
// <root>/gemini-extension.json exists do we parse it and take its `name`
// field, suppressing JSON parse failures (parity with the Python
// suppress(JSONDecodeError)).
export function linkGeminiExtension(ctx: HelperContext): void {
  if (ctx.superpowersRoot === undefined) {
    throw new Error('superpowersRoot is required for link_gemini_extension');
  }
  const root = ctx.superpowersRoot;
  let extensionName = 'superpowers';
  const manifestPath = join(root, 'gemini-extension.json');
  if (existsSync(manifestPath)) {
    extensionName = readGeminiExtensionName(manifestPath, extensionName);
  }

  // Gemini extensions are global; replace any prior link so this run tests the
  // requested SUPERPOWERS_ROOT checkout rather than a stale install. Status is
  // ignored (Python runs this uninstall without check=True).
  ctx.run.run('gemini', ['extensions', 'uninstall', extensionName]);
  const linkResult = ctx.run.run('gemini', ['extensions', 'link', root], {
    input: 'y\n',
  });
  if ((linkResult.status ?? 1) !== 0) {
    throw new Error(`gemini extensions link failed: ${linkResult.stderr}`);
  }

  // Create GEMINI.md with absolute @imports so context loads in the temp workdir.
  const skillsRoot = join(root, 'skills');
  mkdirSync(ctx.workdir, { recursive: true });
  writeFileSync(
    join(ctx.workdir, 'GEMINI.md'),
    `@${skillsRoot}/using-superpowers/SKILL.md\n@${skillsRoot}/using-superpowers/references/gemini-tools.md\n`,
    'utf8',
  );
}

// Helper for linkGeminiExtension: parse <root>/gemini-extension.json and return
// its `name`, falling back to `fallback` on a parse failure (Python suppresses
// only JSONDecodeError) or a missing `name` (Python's `.get("name", default)`).
// JSON.parse output is treated as the boundary value it is and zod-parsed.
const GeminiManifestSchema = z.object({ name: z.string().optional() });

function readGeminiExtensionName(
  manifestPath: string,
  fallback: string,
): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // Python suppresses only json.JSONDecodeError here; a parse failure keeps
    // the default extension name.
    return fallback;
  }
  const parsed = GeminiManifestSchema.safeParse(raw);
  if (parsed.success && parsed.data.name !== undefined) {
    return parsed.data.name;
  }
  return fallback;
}

// Port of worktree.py:create_caller_consent_plan. Adds a committed
// implementation plan that should trigger caller-layer gating; scoped add of
// the plan path relative to the workdir.
export function createCallerConsentPlan(ctx: HelperContext): void {
  const rel = 'docs/superpowers/plans/custom-greeting.md';
  writeFixtureFile(ctx.workdir, rel, CALLER_CONSENT_PLAN);
  runGit(['add', rel], ctx.workdir);
  runGit(['commit', '-m', 'add caller consent gate plan'], ctx.workdir);
}

// Port of worktree_pressure.py:setup_pressure_worktree_conditions. Creates a
// gitignored .worktrees/ directory so the agent faces the obvious-but-wrong
// path. The membership test is the bare substring '.worktrees' (matching
// Python's `'.worktrees' not in contents`).
export function setupPressureWorktreeConditions(ctx: HelperContext): void {
  mkdirSync(join(ctx.workdir, '.worktrees'), { recursive: true });

  const gitignorePath = join(ctx.workdir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const contents = readFileSync(gitignorePath, 'utf8');
    if (!contents.includes('.worktrees')) {
      // Python: contents.rstrip() + '\n.worktrees/\n'
      writeFileSync(
        gitignorePath,
        `${contents.replace(/\s+$/, '')}\n.worktrees/\n`,
        'utf8',
      );
    }
  } else {
    writeFileSync(gitignorePath, '.worktrees/\n', 'utf8');
  }

  runGit(['add', '.gitignore'], ctx.workdir);
  runGit(['commit', '-m', 'ignore .worktrees/'], ctx.workdir);
}

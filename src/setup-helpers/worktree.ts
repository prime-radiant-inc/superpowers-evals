// Worktree helpers for the worktree scenarios. addWorktree/detachHead are
// library functions (not dispatchable); the rest are HelperContext helpers.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { envSnapshot, getEnv, setProcessEnv } from '../env.ts';
import {
  type CodexSessionStartHook,
  queryCodexSessionStartHook,
} from './codex-app-server.ts';
import type { HelperContext } from './context.ts';
import { writeFixtureFile } from './fs.ts';
import { runGit, runGitAllowFail } from './git.ts';

// The committed implementation plan seeded into the caller-consent fixture.
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

// Returns <workdir.parent>/<workdir.name>-<suffix>.
function siblingPath(workdir: string, suffix: string): string {
  return join(dirname(workdir), `${basename(workdir)}-${suffix}`);
}

// Library (not dispatchable). Reusing runGit (which carries the committer
// identity env) is intentional — that env is inert for this non-committing git
// op, so the output is identical to a bare git invocation.
export function addWorktree(
  repoDir: string,
  branch: string,
  worktreePath: string,
): void {
  runGit(['worktree', 'add', '-b', branch, worktreePath], repoDir);
}

// Library (not dispatchable). The final `git branch -D` goes through the
// non-throwing variant: a leftover stale branch is acceptable.
export function detachHead(worktreePath: string): void {
  const commit = runGit(['rev-parse', 'HEAD'], worktreePath).trim();
  const branch = runGit(['branch', '--show-current'], worktreePath).trim();
  runGit(['checkout', '--detach', commit], worktreePath);
  if (branch) {
    runGitAllowFail(['branch', '-D', branch], worktreePath);
  }
}

// Creates an existing worktree (for 'already inside' scenarios).
export function addExistingWorktree(ctx: HelperContext): void {
  addWorktree(
    ctx.workdir,
    'existing-feature',
    siblingPath(ctx.workdir, 'existing-worktree'),
  );
}

// Detaches HEAD in the existing worktree.
export function detachWorktreeHead(ctx: HelperContext): void {
  detachHead(siblingPath(ctx.workdir, 'existing-worktree'));
}

// Creates <workdir>/.agents/skills and symlinks superpowers ->
// <superpowersRoot>/skills. Does not stat the target.
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

// Dirs excluded from the staged Gemini extension copy (at any depth). The whole
// `evals` submodule is dropped: when SUPERPOWERS_ROOT is a superpowers checkout,
// evals/ holds the eval harness's own output (results/, worktrees, run dirs) and
// node_modules — `gemini extensions link` copies the linked dir wholesale into
// the per-run Gemini home, so linking the raw root recursively copies prior run
// output and explodes the destination path. (.git and node_modules are likewise
// not part of the extension.) This is the per-eval analogue of
// _ignore_codex_plugin_copy; see linkGeminiExtension's staging note for why the
// exclusion is broader here (whole `evals`, not just `evals/results`).
const GEMINI_EXTENSION_STAGE_IGNORE: ReadonlySet<string> = new Set<string>([
  '.git',
  'evals',
  'node_modules',
]);

function ignoreGeminiExtensionStage(
  _src: string,
  names: string[],
): Set<string> {
  const ignored = new Set<string>();
  for (const name of names) {
    if (GEMINI_EXTENSION_STAGE_IGNORE.has(name)) {
      ignored.add(name);
    }
  }
  return ignored;
}

// Links superpowers as a Gemini CLI extension and injects project context.
// Extensions are global, but GEMINI.md context loading is project-scoped, so the
// temp workdir needs a GEMINI.md with absolute @imports. The extension name
// defaults to 'superpowers'; only if <root>/gemini-extension.json exists do we
// parse it and take its `name` field, suppressing JSON parse failures.
//
// We link a CLEAN STAGED copy that excludes evals/, .git, and node_modules
// rather than the raw SUPERPOWERS_ROOT. A real superpowers checkout nests the
// entire evals/ submodule — including this harness's own results/ run dirs —
// under SUPERPOWERS_ROOT. `gemini extensions link` (and the antigravity `agy`
// CLI) copy the linked directory wholesale into the per-run Gemini home, so
// linking the raw root recursively re-copies prior run output and explodes the
// destination path (observed live: "copying extension directory: mkdir
// .../.gemini/config/plugins/superpowers/evals/results/<run>/.gemini/config").
// Staging is the fix for that latent explosion.
//
// Staging lifecycle: gemini copies the extension at link time (the live failure
// is literally "copying extension directory"), so the staged dir is unreferenced
// after the link returns. We still leave it in place for the run's lifetime — it
// lives under the run's workdir tree and is reclaimed when the run dir is, and
// keeping it avoids any dependency on undocumented gemini re-read behavior.
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

  // Stage a clean copy of the extension next to the workdir and link THAT, so
  // gemini never copies evals/.git/node_modules. The staging dir lives under the
  // run tree (sibling of workdir) and is reclaimed with it.
  const stageDir = siblingPath(ctx.workdir, 'gemini-extension');
  if (existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  copyTreeWithIgnore(root, stageDir, ignoreGeminiExtensionStage);

  // Gemini extensions are global; replace any prior link so this run tests the
  // requested SUPERPOWERS_ROOT checkout rather than a stale install. Status is
  // ignored — a missing prior install is fine.
  ctx.run.run('gemini', ['extensions', 'uninstall', extensionName]);
  const linkResult = ctx.run.run('gemini', ['extensions', 'link', stageDir], {
    input: 'y\n',
  });
  if ((linkResult.status ?? 1) !== 0) {
    throw new Error(`gemini extensions link failed: ${linkResult.stderr}`);
  }

  // Create GEMINI.md with absolute @imports so context loads in the temp workdir.
  // Point at the staged skills dir — that is the copy gemini actually linked, so
  // the @imports resolve against the same tree the extension was built from.
  const skillsRoot = join(stageDir, 'skills');
  mkdirSync(ctx.workdir, { recursive: true });
  writeFileSync(
    join(ctx.workdir, 'GEMINI.md'),
    `@${skillsRoot}/using-superpowers/SKILL.md\n@${skillsRoot}/using-superpowers/references/gemini-tools.md\n`,
    'utf8',
  );
}

// Helper for linkGeminiExtension: parse <root>/gemini-extension.json and return
// its `name`, falling back to `fallback` on a parse failure or a missing `name`.
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
    // A parse failure keeps the default extension name.
    return fallback;
  }
  const parsed = GeminiManifestSchema.safeParse(raw);
  if (parsed.success && parsed.data.name !== undefined) {
    return parsed.data.name;
  }
  return fallback;
}

// Dirs ignored in EVERY directory during the plugin copy.
const CODEX_PLUGIN_IGNORE_ALWAYS: ReadonlySet<string> = new Set<string>([
  '.git',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.ty',
  '.venv',
  '__pycache__',
  'node_modules',
]);

// The always-ignored set, plus `results` only when the directory being walked is
// itself named `evals` (at any depth). Invoked per-directory with that
// directory's absolute path + its entry names; returns the subset to skip.
function ignoreCodexPluginCopy(src: string, names: string[]): Set<string> {
  const ignored = new Set<string>();
  for (const name of names) {
    if (CODEX_PLUGIN_IGNORE_ALWAYS.has(name)) {
      ignored.add(name);
    }
  }
  if (basename(src) === 'evals') {
    if (names.includes('results')) {
      ignored.add('results');
    }
  }
  return ignored;
}

// A per-directory ignore predicate: given a source directory's absolute path and
// its entry names, return the subset of names to skip.
type IgnorePredicate = (src: string, names: string[]) => Set<string>;

// Recursive copy honoring a per-directory ignore predicate. The predicate is
// consulted with each source directory's absolute path and its entry names;
// matched names are skipped entirely (their subtrees are never walked).
function copyTreeWithIgnore(
  src: string,
  dest: string,
  ignore: IgnorePredicate = ignoreCodexPluginCopy,
): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  const names = entries.map((e) => e.name);
  const ignored = ignore(src, names);
  for (const entry of entries) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTreeWithIgnore(srcPath, destPath, ignore);
    } else if (entry.isSymbolicLink()) {
      // Copy symlinks as files: copyFileSync follows the link and copies the
      // target's contents.
      copyFileSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// Escape a TOML basic string: `\` -> `\\` then `"` -> `\"`.
function tomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// Enable plugins/hooks and the superpowers@debug plugin in the codex config.
function writeCodexPluginHooksConfig(configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `[features]
plugins = true
hooks = true
plugin_hooks = true

[plugins."superpowers@debug"]
enabled = true
`,
    'utf8',
  );
}

// Append the trusted-hash block, with both the key and hash TOML-escaped.
function appendCodexTrustedHook(
  configPath: string,
  key: string,
  currentHash: string,
): void {
  const existing = readFileSync(configPath, 'utf8');
  writeFileSync(
    configPath,
    `${existing}\n[hooks.state."${tomlBasicString(key)}"]\ntrusted_hash = "${tomlBasicString(currentHash)}"\n`,
    'utf8',
  );
}

// Pipe OPENAI_API_KEY (trailing newline) to `codex login --with-api-key`
// against the isolated CODEX_HOME. Throws when the key is missing or the login
// fails.
function loginCodexHomeWithApiKey(
  codexHome: string,
  run: HelperContext['run'],
): void {
  const apiKey = getEnv('OPENAI_API_KEY');
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      'OPENAI_API_KEY is required to log in the isolated Codex home',
    );
  }
  const result = run.run('codex', ['login', '--with-api-key'], {
    input: `${apiKey}\n`,
    env: { ...envSnapshot(), CODEX_HOME: codexHome },
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`codex login --with-api-key failed: ${result.stderr}`);
  }
}

// Injectable seam for the three non-hermetic codex interactions, so the gate
// can exercise the copytree/config/escaping/DRILL_CODEX_HOME logic without a
// real codex CLI or app-server.
interface CodexDeps {
  login(codexHome: string): void;
  queryHook(a: {
    codexHome: string;
    workdir: string;
  }): Promise<CodexSessionStartHook>;
  setEnv(key: string, value: string): void;
}

// Options for the dual-mode codex install.
interface CodexInstallOptions {
  // Caller-supplied, pre-existing, already-logged-in CODEX_HOME. When given,
  // install into it directly and skip the isolated-home build, login, and the
  // DRILL_CODEX_HOME export (the quorum-runner call path). When omitted, the
  // helper is drill-owned: build the isolated sibling home, log in, and export.
  readonly codexHome?: string;
}

// Dual-mode via opts.codexHome:
//   - drill call (codexHome omitted, the CLI dispatch path): build an isolated
//     Codex home next to the workdir, log it in, and export DRILL_CODEX_HOME.
//   - quorum call (codexHome given): install into the runner's per-run CODEX_HOME,
//     which already exists and is already logged in, so the isolated-home build,
//     the login, and the DRILL_CODEX_HOME export are all skipped.
// Either way: stage Superpowers as a plugin and trust its SessionStart hook. The
// three non-hermetic steps (login, app-server query, env write) route through
// CodexDeps so the gate injects fakes.
export async function installCodexSuperpowersPluginHooks(
  ctx: HelperContext,
  deps?: Partial<CodexDeps>,
  opts?: CodexInstallOptions,
): Promise<void> {
  if (ctx.superpowersRoot === undefined) {
    throw new Error(
      'superpowersRoot is required for install_codex_superpowers_plugin_hooks',
    );
  }
  const superpowersRoot = ctx.superpowersRoot;
  const d: CodexDeps = {
    login: (home) => loginCodexHomeWithApiKey(home, ctx.run),
    queryHook: queryCodexSessionStartHook,
    setEnv: (k, v) => setProcessEnv(k, v),
    ...deps,
  };

  const drillOwned = opts?.codexHome === undefined;
  const codexHome = opts?.codexHome ?? siblingPath(ctx.workdir, 'codex-home');
  if (drillOwned) {
    if (existsSync(codexHome)) {
      rmSync(codexHome, { recursive: true, force: true });
    }
    mkdirSync(codexHome, { recursive: true });
    d.login(codexHome);
  }

  const pluginRoot = join(
    codexHome,
    'plugins',
    'cache',
    'debug',
    'superpowers',
    'local',
  );
  mkdirSync(dirname(pluginRoot), { recursive: true });
  copyTreeWithIgnore(superpowersRoot, pluginRoot);

  const configPath = join(codexHome, 'config.toml');
  writeCodexPluginHooksConfig(configPath);
  const hook = await d.queryHook({ codexHome, workdir: ctx.workdir });
  appendCodexTrustedHook(configPath, hook.key, hook.currentHash);

  if (drillOwned) {
    d.setEnv('DRILL_CODEX_HOME', codexHome);
  }
}

// Adds a committed implementation plan that should trigger caller-layer gating;
// scoped add of the plan path relative to the workdir.
export function createCallerConsentPlan(ctx: HelperContext): void {
  const rel = 'docs/superpowers/plans/custom-greeting.md';
  writeFixtureFile(ctx.workdir, rel, CALLER_CONSENT_PLAN);
  runGit(['add', rel], ctx.workdir);
  runGit(['commit', '-m', 'add caller consent gate plan'], ctx.workdir);
}

// Creates a gitignored .worktrees/ directory so the agent faces the
// obvious-but-wrong path. The membership test is the bare substring '.worktrees'.
export function setupPressureWorktreeConditions(ctx: HelperContext): void {
  mkdirSync(join(ctx.workdir, '.worktrees'), { recursive: true });

  const gitignorePath = join(ctx.workdir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const contents = readFileSync(gitignorePath, 'utf8');
    if (!contents.includes('.worktrees')) {
      // Trim trailing whitespace, then append the .worktrees/ entry.
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

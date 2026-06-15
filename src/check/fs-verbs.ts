// check/fs-verbs.ts — one exported function per non-transcript check verb.
//
// Covers the filesystem/git/env verbs (file-exists, file-contains,
// command-succeeds, git-*, assert-checkout-clean, requires-tool) and the 6
// per-harness bootstrap checks. Each verb is a pure(ish) function over a
// CheckContext (cwd + env) and the positional args, returning a CheckOutcome.
//
// The CLI (src/cli/check-tool.ts) maps the outcome to recordPass/recordFail and
// an exit code; broken-check conditions (unknown operator, missing dimension)
// route through the non-invertible 127 band rather than returning a verdict.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { getEnv } from '../env.ts';
import { posixToJsRegex } from './regex.ts';

/** A verb's verdict. `broken` routes through the non-invertible 127 band. */
export interface CheckOutcome {
  /** True when the check is well-formed but failed its assertion. */
  passed: boolean;
  /** Human-readable detail; '' is normalized to null in the record. */
  detail: string;
  /**
   * True for a malformed/under-specified check (unknown operator, missing
   * required dimension). The CLI exits 127 (non-invertible) and `not` refuses
   * to invert it.
   */
  broken?: boolean;
}

/** Ambient state a verb may read: the workdir (cwd) and the environment. */
export interface CheckContext {
  /** The directory checks run from (the fixture workdir). */
  readonly cwd: string;
  /** Environment lookup (delegates to env.ts). */
  readonly env: (key: string) => string | undefined;
}

export function defaultContext(): CheckContext {
  return { cwd: process.cwd(), env: getEnv };
}

function pass(detail = ''): CheckOutcome {
  return { passed: true, detail };
}
function fail(detail = ''): CheckOutcome {
  return { passed: false, detail };
}
function broken(detail: string): CheckOutcome {
  return { passed: false, detail, broken: true };
}

// ---------------------------------------------------------------------------
// file-exists <glob>
// ---------------------------------------------------------------------------
// Pass iff at least one path matches the glob (workdir-relative). Supports a
// single `**` recursive segment. Literal paths with no glob chars match iff
// the path exists.
export function verbFileExists(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const pattern = args[0] ?? '';
  const matches = globMatch(pattern, ctx.cwd);
  if (matches.length > 0) {
    return pass();
  }
  return fail(`no path matched: ${pattern}`);
}

/**
 * Resolve a workdir-relative glob to existing paths:
 *   - a literal path (no glob chars) matches iff it exists;
 *   - `*` / `?` / `[...]` expand within a single path segment;
 *   - a single `**` segment recurses (find -name / -path equivalent).
 * Returns workdir-relative paths.
 */
function globMatch(pattern: string, cwd: string): string[] {
  if (pattern.includes('**')) {
    return globStar(pattern, cwd);
  }
  if (!hasGlobChars(pattern)) {
    // Literal path: exists check (handles spaces, no expansion).
    return existsSync(resolve(cwd, pattern)) ? [pattern] : [];
  }
  // Single-segment glob expansion across the path's segments.
  const segments = pattern.split('/');
  const found = expandSegments(cwd, '', segments, 0);
  return found.filter((rel) => existsSync(resolve(cwd, rel)));
}

function hasGlobChars(p: string): boolean {
  return /[*?[\]]/.test(p);
}

// Expand a path split into segments, where each segment may be a glob. Returns
// workdir-relative paths that exist at each expansion step. Leading-empty
// segments (absolute-style patterns) are not supported (patterns are
// workdir-relative).
function expandSegments(
  cwd: string,
  prefix: string,
  segments: string[],
  index: number,
): string[] {
  if (index >= segments.length) {
    return prefix === '' ? [] : [prefix];
  }
  const seg = segments[index] ?? '';
  const baseAbs = resolve(cwd, prefix);
  if (!hasGlobChars(seg)) {
    const nextRel = prefix === '' ? seg : `${prefix}/${seg}`;
    if (!existsSync(resolve(cwd, nextRel))) {
      return [];
    }
    return expandSegments(cwd, nextRel, segments, index + 1);
  }
  let entries: string[];
  try {
    entries = readdirSync(baseAbs);
  } catch {
    return [];
  }
  const re = globSegmentRegex(seg);
  const out: string[] = [];
  for (const entry of entries) {
    if (!re.test(entry)) continue;
    const nextRel = prefix === '' ? entry : `${prefix}/${entry}`;
    out.push(...expandSegments(cwd, nextRel, segments, index + 1));
  }
  return out;
}

// A `**` recursive glob: split into the literal prefix (dirs before the first
// `**/`) and the suffix (after the last `**/`).
function globStar(pattern: string, cwd: string): string[] {
  const lastIdx = pattern.lastIndexOf('**/');
  const suffix =
    lastIdx >= 0 ? pattern.slice(lastIdx + 3) : pattern.replace(/\*\*/g, '');
  const firstIdx = pattern.indexOf('**/');
  let prefix = firstIdx >= 0 ? pattern.slice(0, firstIdx) : '';
  prefix = prefix.replace(/\/$/, '');
  if (prefix === '') prefix = '.';

  const baseAbs = resolve(cwd, prefix);
  if (!existsSync(baseAbs)) return [];

  const all = walk(baseAbs, prefix);
  const out: string[] = [];
  if (suffix.includes('/')) {
    // A slash survives in the tail (a/**/b/c): match the whole relative path
    // against `*/<suffix>` where * crosses /.
    const re = globPathRegex(`*/${suffix}`);
    for (const rel of all) {
      if (re.test(rel)) out.push(rel);
    }
  } else {
    // Match the basename against the suffix glob (find -name).
    const re = globSegmentRegex(suffix);
    for (const rel of all) {
      const base = rel.split('/').pop() ?? '';
      if (re.test(base)) out.push(rel);
    }
  }
  return out;
}

// Recursively list every path (files and dirs) under `dirAbs`, returning paths
// relative to cwd using `relPrefix` as the workdir-relative base.
function walk(dirAbs: string, relPrefix: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childAbs = join(dirAbs, entry);
    const childRel = relPrefix === '.' ? entry : `${relPrefix}/${entry}`;
    out.push(childRel);
    let isDir = false;
    try {
      isDir = statSync(childAbs).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      out.push(...walk(childAbs, childRel));
    }
  }
  return out;
}

// Convert a single path segment glob (`*`, `?`, `[...]`) to an anchored regex.
// `*` matches any run of non-separator chars; `?` one; `[...]` a char class.
function globSegmentRegex(seg: string): RegExp {
  return new RegExp(`^${globToRegexSource(seg, false)}$`);
}

// Convert a path glob where `*` is allowed to cross `/` (find -path semantics).
function globPathRegex(pat: string): RegExp {
  return new RegExp(`^${globToRegexSource(pat, true)}$`);
}

function globToRegexSource(glob: string, starCrossesSlash: boolean): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*') {
      out += starCrossesSlash ? '.*' : '[^/]*';
    } else if (ch === '?') {
      out += starCrossesSlash ? '.' : '[^/]';
    } else if (ch === '[') {
      // Pass a bracket expression through verbatim up to the closing ].
      let j = i + 1;
      let cls = '[';
      if (glob[j] === '!' || glob[j] === '^') {
        cls += '^';
        j++;
      }
      while (j < glob.length && glob[j] !== ']') {
        cls += glob[j];
        j++;
      }
      cls += ']';
      i = j;
      out += cls;
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// file-contains <path> <ere>
// ---------------------------------------------------------------------------
// Pass iff the file exists and at least one line matches the extended regex
// (grep -qE semantics). POSIX bracket classes are translated to JS equivalents.
export function verbFileContains(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const path = args[0] ?? '';
  const pattern = args[1] ?? '';
  const abs = resolve(ctx.cwd, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return fail(`file not found: ${path}`);
  }
  const text = readFileSync(abs, 'utf8');
  const re = posixToJsRegex(pattern);
  for (const line of text.split('\n')) {
    if (re.test(line)) {
      return pass();
    }
  }
  return fail(`pattern not found in ${path}`);
}

// ---------------------------------------------------------------------------
// command-succeeds <command>
// ---------------------------------------------------------------------------
// Run the command via `bash -c`; pass iff it exits 0. On failure, the first 500
// bytes of combined stdout+stderr become the detail.
export function verbCommandSucceeds(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const command = args[0] ?? '';
  const proc = spawnSync('bash', ['-c', command], {
    cwd: ctx.cwd,
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (proc.error) {
    throw proc.error;
  }
  if ((proc.status ?? 0) === 0) {
    return pass();
  }
  // Take the first 500 bytes of combined stdout+stderr, then strip trailing
  // newlines.
  const combined = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const detail = combined.slice(0, 500).replace(/\n+$/, '');
  return fail(`exit non-zero: ${detail}`);
}

// ---------------------------------------------------------------------------
// git-repo
// ---------------------------------------------------------------------------
export function verbGitRepo(_args: string[], ctx: CheckContext): CheckOutcome {
  if (gitOk(ctx.cwd, ['rev-parse', '--is-inside-work-tree'])) {
    return pass();
  }
  return fail('not a git work tree');
}

// ---------------------------------------------------------------------------
// git-branch <expected|detached>
// ---------------------------------------------------------------------------
export function verbGitBranch(args: string[], ctx: CheckContext): CheckOutcome {
  const expected = args[0] ?? '';
  const current = gitOut(ctx.cwd, ['branch', '--show-current']).trim();
  if (expected === 'detached') {
    return current === ''
      ? pass()
      : fail(`branch is ${current}, expected detached`);
  }
  return current === expected
    ? pass()
    : fail(`branch is '${current}', expected '${expected}'`);
}

// ---------------------------------------------------------------------------
// git-clean
// ---------------------------------------------------------------------------
export function verbGitClean(_args: string[], ctx: CheckContext): CheckOutcome {
  const status = gitOut(ctx.cwd, ['status', '--porcelain']);
  return status.trim() === '' ? pass() : fail('working tree dirty');
}

// ---------------------------------------------------------------------------
// git-count <commits|worktrees> <op> <n>
// ---------------------------------------------------------------------------
const GIT_COUNT_OPS: Record<string, (a: number, b: number) => boolean> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
};

export function verbGitCount(args: string[], ctx: CheckContext): CheckOutcome {
  const dim = args[0] ?? '';
  const op = args[1] ?? '';
  const nRaw = args[2] ?? '';
  let count: number;
  if (dim === 'worktrees') {
    // `git worktree list | wc -l` counts lines, including the main worktree.
    const out = gitOut(ctx.cwd, ['worktree', 'list']);
    count = out.split('\n').filter((l) => l.length > 0).length;
  } else if (dim === 'commits') {
    const out = gitOut(ctx.cwd, ['rev-list', '--count', 'HEAD']).trim();
    count = out === '' ? 0 : Number.parseInt(out, 10);
  } else {
    return broken(`unknown dimension: ${dim}`);
  }
  const cmp = GIT_COUNT_OPS[op];
  if (!cmp) {
    return broken(`unknown op: ${op}`);
  }
  const n = Number.parseInt(nRaw, 10);
  return cmp(count, n) ? pass() : fail(`${dim} count ${count} not ${op} ${n}`);
}

// ---------------------------------------------------------------------------
// assert-checkout-clean <path>
// ---------------------------------------------------------------------------
// The tree at <path> must be a clean git work tree whose HEAD has not moved
// from the recorded sentinel (if present). The .quorum-launch-cwd sentinel is
// harness plumbing and ignored.
export function verbAssertCheckoutClean(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const path = args[0] ?? '';
  const abs = resolve(ctx.cwd, path);
  if (!gitOk(abs, ['rev-parse', '--is-inside-work-tree'])) {
    return fail(`${path} is not a git work tree`);
  }
  const status = spawnSync('git', ['-C', abs, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
  if ((status.status ?? 1) !== 0) {
    return fail(`git status failed at ${path}`);
  }
  const dirtyLines = (status.stdout ?? '')
    .split('\n')
    .filter((l) => l.length > 0)
    .filter((l) => l !== '?? .quorum-launch-cwd');
  if (dirtyLines.length > 0) {
    const head = dirtyLines.slice(0, 3).join(' ');
    return fail(`tree at ${path} not clean: ${head}`);
  }
  const gitDir = gitOut(abs, ['rev-parse', '--absolute-git-dir']).trim();
  if (gitDir) {
    const recorded = join(gitDir, 'quorum-recorded-head');
    if (existsSync(recorded)) {
      const headNow = gitOut(abs, ['rev-parse', 'HEAD']).trim();
      const headThen = readFileSync(recorded, 'utf8').replace(/\s/g, '');
      if (headNow !== headThen) {
        return fail(`HEAD at ${path} moved: ${headThen} -> ${headNow}`);
      }
    }
  }
  return pass();
}

// ---------------------------------------------------------------------------
// requires-tool <tool...>
// ---------------------------------------------------------------------------
// Pre-phase guard: every named tool must be on PATH. A missing tool fails the
// pre-check, which the composer maps to `indeterminate` (env-missing).
export function verbRequiresTool(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  if (args.length < 1) {
    return broken('no tool name(s) provided');
  }
  const missing = args.filter((tool) => !onPath(tool, ctx));
  if (missing.length === 0) {
    return pass(`all required tools on PATH: ${args.join(' ')}`);
  }
  return fail(`required tool(s) not on PATH: ${missing.join(' ')}`);
}

function onPath(tool: string, ctx: CheckContext): boolean {
  const path = ctx.env('PATH') ?? '';
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, tool);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        return true;
      }
    } catch {
      // not here; keep looking
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// files-exist <root> <rel...>
// ---------------------------------------------------------------------------
// Generic "all of these relative files exist under <root>" check; the simple
// per-harness bootstrap checks delegate here. Pass iff every <rel> is a regular
// file under <root>.
export function verbFilesExist(
  args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const root = args[0] ?? '';
  const rels = args.slice(1);
  if (root === '' || rels.length === 0) {
    return broken('files-exist: needs <root> and at least one <rel>');
  }
  return filesExistUnder(resolve(ctx.cwd, root), rels);
}

/** Shared helper: every rel must be a regular file under rootAbs. */
function filesExistUnder(rootAbs: string, rels: string[]): CheckOutcome {
  const missing = rels.filter((rel) => !isFile(join(rootAbs, rel)));
  if (missing.length === 0) {
    return pass();
  }
  return fail(missing.join(', '));
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function exists(abs: string): boolean {
  return existsSync(abs);
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function gitOk(cwd: string, gitArgs: string[]): boolean {
  const proc = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  return (proc.status ?? 1) === 0;
}

function gitOut(cwd: string, gitArgs: string[]): string {
  const proc = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
  if ((proc.status ?? 1) !== 0) return '';
  return proc.stdout ?? '';
}

// ---------------------------------------------------------------------------
// Bootstrap checks: per-harness "is the Superpowers plugin staged?" verbs.
// Each keeps its own record `check` name; the simple four delegate to
// filesExistUnder. kimi/codex carry extra structured logic.
// ---------------------------------------------------------------------------

// antigravity-plugin-installed
export function verbAntigravityPluginInstalled(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const runDir = ctx.env('QUORUM_RUN_DIR');
  if (!runDir) {
    return fail('QUORUM_RUN_DIR is not set');
  }
  const root = join(
    runDir,
    'coding-agent-config/.gemini/config/plugins/superpowers',
  );
  const result = filesExistUnder(root, [
    'plugin.json',
    'hooks.json',
    'skills/using-superpowers/SKILL.md',
  ]);
  if (result.passed) {
    return pass(`Superpowers plugin installed at ${root}`);
  }
  return fail(`missing Antigravity Superpowers plugin files: ${result.detail}`);
}

// copilot-plugin-installed
export function verbCopilotPluginInstalled(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const runDir = ctx.env('QUORUM_RUN_DIR');
  const home = runDir
    ? join(runDir, 'coding-agent-config')
    : (ctx.env('COPILOT_HOME') ?? '');
  const root = join(home, 'plugins/superpowers');
  const result = filesExistUnder(root, [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
    'skills/using-superpowers/SKILL.md',
    'skills/brainstorming/SKILL.md',
    'skills/using-superpowers/references/copilot-tools.md',
  ]);
  if (result.passed) {
    return pass('Copilot Superpowers plugin staged in isolated config');
  }
  return fail(`missing Copilot Superpowers plugin files: ${result.detail}`);
}

// opencode-plugin-installed
export function verbOpencodePluginInstalled(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const runDir = ctx.env('QUORUM_RUN_DIR');
  const home = runDir
    ? join(runDir, 'coding-agent-config')
    : (ctx.env('OPENCODE_QUORUM_HOME') ?? '');
  const configDir = join(home, '.config/opencode');
  const plugin = join(configDir, 'plugins/superpowers.js');
  const usingSkill = join(
    configDir,
    'superpowers/skills/using-superpowers/SKILL.md',
  );
  if (!exists(plugin)) {
    return fail(`OpenCode Superpowers plugin missing at ${plugin}`);
  }
  if (!isFile(usingSkill)) {
    return fail(`OpenCode using-superpowers skill missing at ${usingSkill}`);
  }
  return pass('OpenCode Superpowers plugin installed in isolated config');
}

// gemini-extension-linked
export function verbGeminiExtensionLinked(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const runDir = ctx.env('QUORUM_RUN_DIR');
  if (!runDir) {
    return fail('QUORUM_RUN_DIR is not set');
  }
  const root = join(runDir, 'coding-agent-config/.gemini');
  const result = filesExistUnder(root, [
    'extensions/superpowers/.gemini-extension-install.json',
    'extensions/extension-enablement.json',
    'extension_integrity.json',
  ]);
  if (result.passed) {
    return pass(
      `Superpowers Gemini extension linked at ${root}/extensions/superpowers`,
    );
  }
  return fail(
    `missing Gemini Superpowers extension metadata: ${result.detail}`,
  );
}

// kimi-plugin-installed — ports the 104-line jq tool to TS.
export function verbKimiPluginInstalled(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  const runDir = ctx.env('QUORUM_RUN_DIR');
  if (!runDir) {
    return fail('QUORUM_RUN_DIR is not set');
  }
  const superpowersRoot = ctx.env('SUPERPOWERS_ROOT');
  if (!superpowersRoot) {
    return fail('SUPERPOWERS_ROOT is not set');
  }

  const kimiHome = join(runDir, 'coding-agent-config');
  const installed = join(kimiHome, 'plugins/installed.json');
  const managedRoot = join(kimiHome, 'plugins/managed/superpowers');

  if (!isFile(installed)) {
    return fail(`missing Kimi installed.json at ${installed}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(installed, 'utf8'));
  } catch {
    return fail(`Kimi installed.json is not valid JSON at ${installed}`);
  }

  const plugins = readPluginsArray(parsed);
  const enabled = plugins.filter(
    (p) => p['id'] === 'superpowers' && p['enabled'] === true,
  );
  if (enabled.length !== 1) {
    return fail(
      `expected exactly one enabled Superpowers plugin in ${installed}; found ${enabled.length}`,
    );
  }
  const plugin = enabled[0] as Record<string, unknown>;

  const source = typeof plugin['source'] === 'string' ? plugin['source'] : '';
  if (source !== 'local-path') {
    return fail(
      `Kimi Superpowers plugin source must be local-path; found ${source || 'missing'}`,
    );
  }

  const rootField = plugin['root'];
  if (typeof rootField !== 'string' || rootField === '') {
    return fail(
      `enabled local-path Superpowers plugin root missing from ${installed}`,
    );
  }

  const pluginRootReal = realpathOrNull(rootField);
  if (pluginRootReal === null) {
    return fail(`Kimi Superpowers plugin root does not resolve: ${rootField}`);
  }
  const expectedRootReal = realpathOrNull(superpowersRoot);
  if (expectedRootReal === null) {
    return fail(`SUPERPOWERS_ROOT does not resolve: ${superpowersRoot}`);
  }

  if (pluginRootReal !== expectedRootReal) {
    return fail(
      `Kimi Superpowers plugin root ${pluginRootReal} does not match SUPERPOWERS_ROOT ${expectedRootReal}`,
    );
  }

  if (exists(managedRoot)) {
    return fail(
      `Kimi Superpowers plugin must not use copied managed plugin root ${managedRoot}`,
    );
  }

  const required = [
    '.kimi-plugin/plugin.json',
    'skills/using-superpowers/SKILL.md',
  ];
  const missing = required.filter((rel) => !isFile(join(pluginRootReal, rel)));
  if (missing.length === 0) {
    return pass(
      `Kimi local-path Superpowers plugin configured from ${pluginRootReal}`,
    );
  }
  return fail(`missing Kimi Superpowers plugin files: ${missing.join(', ')}`);
}

function readPluginsArray(parsed: unknown): Record<string, unknown>[] {
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { plugins?: unknown }).plugins)
  ) {
    return (parsed as { plugins: unknown[] }).plugins.filter(
      (p): p is Record<string, unknown> =>
        p !== null && typeof p === 'object' && !Array.isArray(p),
    );
  }
  return [];
}

function realpathOrNull(path: string): string | null {
  try {
    // realpathSync resolves symlinks; relative ./../ are resolved against cwd
    // by the OS, matching coreutils realpath.
    return realpathSync(path);
  } catch {
    return null;
  }
}

// codex-native-hook-configured — ports the toml greps to TS regex.
export function verbCodexNativeHookConfigured(
  _args: string[],
  ctx: CheckContext,
): CheckOutcome {
  let codexHomeDir: string;
  const codexHome = ctx.env('CODEX_HOME');
  const runDir = ctx.env('QUORUM_RUN_DIR');
  if (codexHome) {
    codexHomeDir = codexHome;
  } else if (runDir) {
    codexHomeDir = join(runDir, 'coding-agent-config');
  } else {
    codexHomeDir = 'coding-agent-config';
  }

  const config = resolve(ctx.cwd, join(codexHomeDir, 'config.toml'));
  const plugin = resolve(
    ctx.cwd,
    join(codexHomeDir, 'plugins/cache/debug/superpowers/local'),
  );

  if (!isFile(config)) {
    return fail(`missing Codex config at ${config}`);
  }
  if (!isFile(join(plugin, '.codex-plugin/plugin.json'))) {
    return fail('missing staged Codex plugin manifest');
  }
  if (!isFile(join(plugin, 'hooks/run-hook.cmd'))) {
    return fail('missing staged Codex hook runner');
  }

  const toml = readFileSync(config, 'utf8');
  if (!toml.includes('plugin_hooks = true')) {
    return fail('plugin_hooks feature not enabled');
  }
  if (!toml.includes('[plugins."superpowers@debug"]')) {
    return fail('debug Superpowers plugin not enabled');
  }
  if (!/hooks\.state\."superpowers@debug:[^"]*session_start/.test(toml)) {
    return fail('Superpowers Codex hook trust state missing');
  }
  if (!/trusted_hash = "sha256:[a-f0-9]+"/.test(toml)) {
    return fail('trusted hook hash missing');
  }
  return pass('Codex native Superpowers hook configured');
}

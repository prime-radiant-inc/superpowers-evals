// Scaffold and validate scenario directories.
//
// newScenario stamps a structurally-valid scenario skeleton (story.md,
// setup.sh, checks.sh) with the executable bit set on setup.sh.
// checkScenario validates an existing scenario — checks.sh must exist,
// parse, define pre() and post(), and be functions-only.

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FS_VERBS } from './check/dispatch.ts';
import { TRANSCRIPT_VERBS } from './check/transcript-dispatch.ts';
import { validateBaselineManifest } from './scenario-manifest.ts';
import { KNOWN_HELPER_NAMES } from './setup-helpers/registry.ts';

// The valid quorum_tier set; matches src/story-meta.ts readQuorumTier.
const VALID_TIERS = ['sentinel', 'full', 'adhoc'] as const;

// Scaffolded story.md skeleton ({name} interpolated).
const STORY_TEMPLATE = `---
id: {name}
title: TODO one-line title
status: draft
quorum_tier: full
tags: TODO
---

TODO: brief the QA agent — what it is role-playing, the exact message
it should send the agent under test, and when it is done.

## Acceptance Criteria

- TODO: what must be true after the run. Make criteria evidence-demanding
  (e.g. "a Skill invocation naming superpowers:X appears in the agent's
  session log").
`;

// Scaffolded setup.sh: invokes the TS setup-helpers via the bare `setup-helpers`
// verb (defined by the sourced check prelude), matching every real scenario.
const SETUP_TEMPLATE = `#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo
`;

// Scaffolded checks.sh skeleton.
const CHECKS_TEMPLATE = `# Deterministic checks for this scenario. Run by quorum.
# pre() runs after setup.sh, before the Coding-Agent.
# post() runs after the Coding-Agent's run is captured.

pre() {
    git-repo
    git-branch main
}

post() {
    : # TODO: add checks
}
`;

/** Raised when a scenario cannot be scaffolded. */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

/**
 * Create a structurally-valid scenario skeleton; return its directory.
 *
 * `name` is the scenario's name as the user supplied it, stamped verbatim into
 * the story `id:` (the raw name, so `foo/bar` yields `id: foo/bar`, not just the
 * final segment). When omitted it defaults to the directory's basename.
 */
export function newScenario(scenarioDir: string, name?: string): string {
  if (existsSync(scenarioDir)) {
    throw new ScaffoldError(`scenario already exists: ${scenarioDir}`);
  }
  mkdirSync(scenarioDir, { recursive: true });

  const storyId = name ?? basename(scenarioDir);
  writeFileSync(
    join(scenarioDir, 'story.md'),
    STORY_TEMPLATE.replace('{name}', storyId),
  );

  const setup = join(scenarioDir, 'setup.sh');
  writeFileSync(setup, SETUP_TEMPLATE);
  chmodSync(setup, 0o755);

  // checks.sh: sourced via `bash <path>`, not executed directly — no chmod.
  writeFileSync(join(scenarioDir, 'checks.sh'), CHECKS_TEMPLATE);

  return scenarioDir;
}

// A full YAML parse of the leading --- block. Returns a record only when the
// block parses to a mapping; otherwise an empty record. The body is text[3..end]
// where end is the index of the first "\n---" found from offset 3.
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(text.slice(3, end));
  } catch {
    return {};
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // A YAML mapping deserializes to a plain object; its values stay unknown
    // and are presence-checked / narrowed by the caller.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = value;
    }
    return out;
  }
  return {};
}

// Validate checks.sh: exists, parses with `bash -n`, is functions-only, defines
// pre()/post(), and is free of the backgrounded-check and $QUORUM_WORKDIR lints.
function validateChecksSh(scenarioDir: string): string[] {
  const cs = join(scenarioDir, 'checks.sh');
  const problems: string[] = [];
  if (!existsSync(cs)) {
    problems.push('checks.sh missing');
    return problems;
  }
  const proc = spawnSync('bash', ['-n', cs], { encoding: 'utf8' });
  if (proc.status !== 0) {
    const stderr = typeof proc.stderr === 'string' ? proc.stderr : '';
    problems.push(`checks.sh syntax error: ${stderr.trim()}`);
    return problems;
  }
  const text = readFileSync(cs, 'utf8');

  // Functions-only: any non-blank, non-comment line that is not part of a
  // function definition is a top-level statement and is disallowed. We track
  // brace depth; function-declaration lines (pre/post) open a scope.
  let inFn = 0;
  for (const line of pySplitlines(text)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const isFnDecl = /^(pre|post)\s*\(\)/.test(s);
    const opens = countChar(s, '{');
    const closes = countChar(s, '}');
    if (isFnDecl) {
      // Net braces on this line: if opens > closes the body continues.
      inFn = Math.max(0, inFn + opens - closes);
      continue;
    }
    if (s === '{') {
      inFn += 1;
      continue;
    }
    if (s === '}') {
      inFn = Math.max(0, inFn - 1);
      continue;
    }
    if (inFn === 0) {
      problems.push(
        `checks.sh must be functions-only (top-level statement: ${pyRepr(s.slice(0, 60))})`,
      );
      break;
    }
  }
  if (!/^pre\s*\(\)/m.test(text)) {
    problems.push('checks.sh missing pre() function');
  }
  if (!/^post\s*\(\)/m.test(text)) {
    problems.push('checks.sh missing post() function');
  }
  // Concurrency-unsupported lint: warn on backgrounded check invocations.
  const lines = pySplitlines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/(?<!&)&(?!&)\s*(#|$)/.test(line) && !/^\s*#/.test(line)) {
      problems.push(
        `checks.sh:${i + 1}: backgrounded check (\`&\`) is unsupported`,
      );
    }
  }
  // $QUORUM_WORKDIR is not set — checks run with cwd=workdir, so paths are
  // workdir-relative. Flag any reference to it.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/\$\{?QUORUM_WORKDIR\b/.test(line)) {
      problems.push(
        `checks.sh:${i + 1}: $QUORUM_WORKDIR is not available; ` +
          'cwd is the workdir — use relative paths',
      );
    }
  }
  problems.push(...validateCheckVerbs(text));
  return problems;
}

// Count occurrences of a single character in a string.
function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) n += 1;
  }
  return n;
}

// The full Unicode line-boundary set: LF, CR, CRLF (one boundary), VT (U+000B),
// FF (U+000C), FS/GS/RS (U+001C-U+001E), NEL (U+0085), LS (U+2028), PS (U+2029).
// \r\n is listed first so it is consumed as a single boundary rather than two.
// The control-character escapes are deliberate, so the noControlCharactersInRegex
// lint is suppressed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the full Unicode line-boundary set requires these control-character escapes
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

// Split on every line boundary above, drop the separators, and emit NO trailing
// empty element. A plain split('\n') would diverge by keeping \r/\v/etc.
// attached, adding a trailing empty line, and not breaking on bare \r or the
// other Unicode boundaries.
export function pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  LINE_BOUNDARY.lastIndex = 0;
  for (
    let m = LINE_BOUNDARY.exec(text);
    m !== null;
    m = LINE_BOUNDARY.exec(text)
  ) {
    lines.push(text.slice(start, m.index));
    start = m.index + m[0].length;
  }
  // A boundary at end-of-string leaves start === text.length; splitlines()
  // emits no trailing empty line, so push a final segment only when one
  // remains.
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

// Quote the short top-level-statement snippet for problem output: wrap in single
// quotes, escaping backslashes and embedded single quotes. The snippet is a
// one-line trimmed slice, so no control-char escaping is needed here.
function pyRepr(s: string): string {
  const escaped = s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Return a list of structural problems; an empty list means valid. */
export function checkScenario(scenarioDir: string): string[] {
  const problems: string[] = [];

  const story = join(scenarioDir, 'story.md');
  if (!existsSync(story)) {
    problems.push('story.md missing');
  } else {
    const text = readFileSync(story, 'utf8');
    const fm = parseFrontmatter(text);
    for (const key of ['id', 'title']) {
      if (!(key in fm)) {
        problems.push(`story.md frontmatter missing '${key}'`);
      }
    }
    if (!text.includes('## Acceptance Criteria')) {
      problems.push("story.md missing '## Acceptance Criteria' section");
    }
    const tier = fm['quorum_tier'];
    if (tier !== undefined && tier !== null && !isValidTier(tier)) {
      problems.push(
        `story.md quorum_tier=${pyReprValue(tier)} is not valid ` +
          `(expected one of: ${VALID_TIERS.join(', ')})`,
      );
    }
  }

  const setup = join(scenarioDir, 'setup.sh');
  if (existsSync(setup) && !isExecutable(setup)) {
    problems.push('setup.sh is not executable');
  }

  if (existsSync(setup)) {
    const setupText = readFileSync(setup, 'utf8');
    // Every helper actually dispatched by a `setup-helpers run <args>` line, with
    // the captured args split on whitespace. Both the unknown-helper check and the
    // fixtures guard key off real dispatches, not an incidental mention in a comment.
    const dispatched = new Set(
      [...setupText.matchAll(/setup-helpers\s+run\s+(.+)/g)].flatMap((m) =>
        (m[1] ?? '').split(/\s+/).filter((h) => h !== ''),
      ),
    );
    for (const helper of dispatched) {
      if (!KNOWN_HELPER_NAMES.has(helper)) {
        problems.push(`setup.sh references unknown helper '${helper}'`);
      }
    }
    if (dispatched.has('init_repo_from_fixtures')) {
      const fixturesDir = join(scenarioDir, 'fixtures');
      const present =
        existsSync(fixturesDir) && readdirSync(fixturesDir).length > 0;
      if (!present) {
        problems.push(
          'setup.sh calls init_repo_from_fixtures but fixtures/ is missing or empty',
        );
      }
    }
  }

  problems.push(...validateChecksSh(scenarioDir));
  if (existsSync(join(scenarioDir, 'baseline-manifest.json'))) {
    problems.push(...validateBaselineManifest(scenarioDir));
  }

  return problems;
}

// Leading tokens that are legitimate in a checks.sh body but are not check
// verbs: the prelude's non-verb functions, bash keywords/builtins seen in
// scenario bodies, and test/grouping syntax. A token starting with a quote,
// $, (, or containing = (assignment) is skipped as not-a-command.
const CHECKS_SH_ALLOWED_TOKENS: ReadonlySet<string> = new Set([
  'not',
  'check-transcript',
  'setup-helpers',
  'inject-user-preference',
  ':',
  'true',
  'false',
  'local',
  'return',
  'echo',
  'cd',
  'export',
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  '[',
  '[[',
  '{',
  '}',
  '!',
]);

// Conservative static verb lint over pre()/post() bodies (PRI-2494): the
// FIRST token of each body line must be a known check verb, an allowed
// shell token, or obviously not a command (assignment, expansion, quote).
// `not <inner>` recurses one level; `check-transcript <sub>` validates the
// subverb. This is a typo catcher, not a bash parser: unknown tokens are
// reported, everything structurally ambiguous is let through.
function validateCheckVerbs(text: string): string[] {
  const problems: string[] = [];
  const lines = pySplitlines(text);
  let inFn = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const isFnDecl = /^(pre|post)\s*\(\)/.test(s);
    const opens = countChar(s, '{');
    const closes = countChar(s, '}');
    if (isFnDecl) {
      inFn = Math.max(0, inFn + opens - closes);
      continue;
    }
    if (s === '{') {
      inFn += 1;
      continue;
    }
    if (s === '}') {
      inFn = Math.max(0, inFn - 1);
      continue;
    }
    if (inFn === 0) continue; // top-level lines are validateChecksSh's problem
    problems.push(...lintCommandLine(s, i + 1));
    if (inFn > 0) inFn = Math.max(0, inFn + opens - closes);
  }
  return problems;
}

// Lint one in-function line's leading command token (recursing through `not`).
function lintCommandLine(s: string, lineNo: number): string[] {
  const tokens = s.split(/\s+/);
  const tok = tokens[0] ?? '';
  // Not command-shaped: assignments, expansions, quotes, subshells, redirects.
  if (tok === '' || tok.includes('=') || /^["'$(<>&|;]/.test(tok)) {
    return [];
  }
  if (tok === 'not') {
    // Validate the inner verb the same way (one level; `not not x` is not used).
    return lintCommandLine(tokens.slice(1).join(' '), lineNo);
  }
  if (tok === 'check-transcript') {
    const sub = tokens[1] ?? '';
    if (sub !== '' && !sub.startsWith('$') && !TRANSCRIPT_VERBS.has(sub)) {
      return [`checks.sh:${lineNo}: unknown check-transcript verb '${sub}'`];
    }
    return [];
  }
  if (Object.hasOwn(FS_VERBS, tok) || CHECKS_SH_ALLOWED_TOKENS.has(tok)) {
    return [];
  }
  return [`checks.sh:${lineNo}: unknown check verb '${tok}'`];
}

function isValidTier(tier: unknown): boolean {
  return tier === 'sentinel' || tier === 'full' || tier === 'adhoc';
}

// Render a frontmatter value for the invalid-tier message: strings get
// single-quoted, booleans render as `True`/`False`, and everything else uses its
// plain string form (e.g. a YAML int). Covers every value a quorum_tier field
// can hold.
function pyReprValue(value: unknown): string {
  if (typeof value === 'string') return pyRepr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

// Executability is resolved against the caller's euid/ownership, not by OR-ing
// all three execute bits. As the file's non-root owner this consults the OWNER
// execute bit specifically; a file whose only execute bits are group/other
// (e.g. 0o011) is NOT executable to its owner.
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * chmod +x setup.sh if it is missing the executable bit. Returns the
 * scenario-relative paths fixed. setup.sh is the only script quorum execs
 * directly.
 */
export function fixExecutableBits(scenarioDir: string): string[] {
  const fixed: string[] = [];
  const setup = join(scenarioDir, 'setup.sh');
  if (existsSync(setup) && !isExecutable(setup)) {
    const mode = statSync(setup).mode;
    chmodSync(setup, mode | 0o111);
    fixed.push(relative(scenarioDir, setup));
  }
  return fixed;
}

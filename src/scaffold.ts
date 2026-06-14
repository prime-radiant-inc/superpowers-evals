// Scaffold and validate scenario directories.
//
// newScenario stamps a structurally-valid scenario skeleton (story.md,
// setup.sh, checks.sh) with the executable bit set on setup.sh.
// checkScenario validates an existing scenario — checks.sh must exist,
// parse, define pre() and post(), and be functions-only.
//
// Ported from quorum/scaffold.py (the oracle). Problem strings are
// reproduced verbatim from the Python so triage output stays identical.

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { KNOWN_HELPER_NAMES } from './setup-helpers/registry.ts';

// The valid quorum_tier set; matches src/story-meta.ts readQuorumTier.
const VALID_TIERS = ['sentinel', 'full', 'adhoc'] as const;

// _STORY_TEMPLATE — verbatim from scaffold.py 21-38 ({name} interpolated).
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

// Scaffolded setup.sh: invokes the TS setup-helpers via the PATH-resolved
// `setup-helpers` shim (bin-ts/setup-helpers), matching every real scenario.
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
 * the story `id:` (Python new_scenario stamps the raw name, so `foo/bar` yields
 * `id: foo/bar`, not just the final segment). When omitted it defaults to the
 * directory's basename.
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

// Port of _parse_frontmatter (scaffold.py 86-96): a full YAML parse of the
// leading --- block. Returns a record only when the block parses to a mapping;
// otherwise an empty record. The body is text[3..end] where end is the index
// of the first "\n---" found from offset 3 (matching str.find).
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

// Port of _validate_checks_sh (scaffold.py 99-154): checks.sh exists, parses
// with `bash -n`, is functions-only, defines pre()/post(), and is free of the
// backgrounded-check and $QUORUM_WORKDIR lints.
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
  // $QUORUM_WORKDIR is not set in the new model — checks run with cwd=workdir,
  // so paths are workdir-relative. Catch stale ports from the old format.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/\$\{?QUORUM_WORKDIR\b/.test(line)) {
      problems.push(
        `checks.sh:${i + 1}: $QUORUM_WORKDIR is not available; ` +
          'cwd is the workdir — use relative paths',
      );
    }
  }
  return problems;
}

// Count occurrences of a single character in a string (parity with str.count).
function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) n += 1;
  }
  return n;
}

// The Unicode line boundaries Python's str.splitlines() breaks on: LF, CR,
// CRLF (one boundary), VT (U+000B), FF (U+000C), FS/GS/RS (U+001C-U+001E),
// NEL (U+0085), LS (U+2028), PS (U+2029). \r\n is listed first so it is
// consumed as a single boundary rather than two. The control-character escapes
// are deliberate (str.splitlines parity), so the noControlCharactersInRegex
// lint is suppressed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: splitlines() parity requires the full Unicode line-boundary set
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

// Port of Python str.splitlines(): split on every line boundary above, drop
// the separators, and emit NO trailing empty element. text.split('\n')
// diverges by keeping \r/\v/etc. attached, adding a trailing empty line, and
// not breaking on bare \r or the other Unicode boundaries.
function pySplitlines(text: string): string[] {
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

// Reproduce Python's repr() for the short top-level-statement snippet: wrap in
// single quotes, escaping backslashes and embedded single quotes. The snippet
// is a one-line trimmed slice, so no control-char escaping is needed here.
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
    // Port of re.finditer(r"setup-helpers\s+run\s+(.+)", ...): each match's
    // group(1) is split on whitespace and every token must be a known helper.
    const re = /setup-helpers\s+run\s+(.+)/g;
    for (const match of setupText.matchAll(re)) {
      const group = match[1] ?? '';
      for (const helper of group.split(/\s+/).filter((h) => h !== '')) {
        if (!KNOWN_HELPER_NAMES.has(helper)) {
          problems.push(`setup.sh references unknown helper '${helper}'`);
        }
      }
    }
  }

  problems.push(...validateChecksSh(scenarioDir));

  return problems;
}

function isValidTier(tier: unknown): boolean {
  return tier === 'sentinel' || tier === 'full' || tier === 'adhoc';
}

// Render a frontmatter value the way Python's f-string {tier!r} would for the
// invalid-tier message. Strings get single-quoted repr; everything else uses
// its plain string form (e.g. a YAML int/bool), matching repr() closely enough
// for the values a quorum_tier field can hold.
function pyReprValue(value: unknown): string {
  if (typeof value === 'string') return pyRepr(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

// os.access(path, os.X_OK) parity: executability is resolved against the
// caller's euid/ownership, not by OR-ing all three execute bits. As the file's
// non-root owner this consults the OWNER execute bit specifically; a file whose
// only execute bits are group/other (e.g. 0o011) is NOT executable to its owner,
// matching Python's check_scenario and fix_executable_bits.
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
 * scenario-relative paths fixed. Port of fix_executable_bits (scaffold.py
 * 196-212): setup.sh is the only script quorum execs directly.
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

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
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

// The valid quorum_tier set; matches src/story-meta.ts readQuorumTier.
const VALID_TIERS = ['sentinel', 'full', 'adhoc'] as const;

// Known setup-helpers registry keys. Mirrors HELPER_REGISTRY in
// setup_helpers/__init__.py — these are the registry KEYS, which differ from
// the module/function names (e.g. add_sdd_auth_plan is registered under that
// key, not the file stem). The registry is statically defined, so this is an
// exact copy of the keys, not the file-stem fallback.
// keep-in-sync-until-Spec-6: when setup_helpers moves to TS (Spec 6), import
// the registry instead of duplicating its keys here.
const KNOWN_HELPERS = new Set<string>([
  'create_base_repo',
  'add_worktree',
  'detach_head',
  'symlink_superpowers',
  'install_codex_superpowers_plugin_hooks',
  'add_existing_worktree',
  'detach_worktree_head',
  'link_gemini_extension',
  'create_caller_consent_plan',
  'create_spec_writing_blind_spot',
  'create_claim_without_verification',
  'create_phantom_completion',
  'create_review_pushback',
  'create_spec_targets_wrong_component',
  'create_spec_targets_wrong_component_with_checkpoint',
  'add_stub_executing_plan',
  'create_writing_plans_skeleton',
  'create_code_review_planted_bugs',
  'add_flawed_spec_for_review',
  'add_sdd_auth_plan',
  'scaffold_sdd_broken_plan',
  'scaffold_sdd_go_fractals',
  'scaffold_sdd_go_fractals_crisp',
  'scaffold_sdd_go_fractals_coarse',
  'scaffold_sdd_go_fractals_control_plan',
  'scaffold_sdd_go_fractals_critical_plan',
  'scaffold_sdd_go_fractals_elicited',
  'scaffold_sdd_go_fractals_stripped',
  'scaffold_sdd_svelte_todo',
  'scaffold_sdd_svelte_todo_elicited',
  'scaffold_sdd_quality_defect_plan',
  'scaffold_sdd_yagni_plan',
  'setup_pressure_worktree_conditions',
  'create_cost_checkbox_page',
  'create_cost_clean_repo',
  'create_cost_trivial_plan',
  'create_cost_large_files',
  'record_head',
]);

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

// _SETUP_TEMPLATE — verbatim from scaffold.py 40-44.
const SETUP_TEMPLATE = `#!/usr/bin/env bash
set -euo pipefail
uv run setup-helpers run create_base_repo
`;

// _CHECKS_TEMPLATE — verbatim from scaffold.py 46-59.
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

/** Create a structurally-valid scenario skeleton; return its directory. */
export function newScenario(scenarioDir: string): string {
  if (existsSync(scenarioDir)) {
    throw new ScaffoldError(`scenario already exists: ${scenarioDir}`);
  }
  mkdirSync(scenarioDir, { recursive: true });

  // The story `id` is the scenario's final path segment (its name).
  const name = basename(scenarioDir);
  writeFileSync(
    join(scenarioDir, 'story.md'),
    STORY_TEMPLATE.replace('{name}', name),
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
  for (const line of text.split('\n')) {
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
  const lines = text.split('\n');
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
        if (!KNOWN_HELPERS.has(helper)) {
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

// statSync(path).mode & 0o111 !== 0 — any execute bit (owner/group/other) set.
function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
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

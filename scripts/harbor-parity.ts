#!/usr/bin/env bun
/**
 * Harbor-parity validation harness — dev-only oracle runner.
 *
 * Usage:
 *   bun scripts/harbor-parity.ts <agent> <session-log-dir>
 *
 * Where:
 *   <agent>           — normalizer name: claude, codex, gemini, opencode,
 *                       copilot, kimi, pi, antigravity
 *   <session-log-dir> — directory containing the agent's session log(s)
 *                       (for claude: the per-project directory that contains
 *                       the *.jsonl files, e.g. home/.claude/projects/<slug>/)
 *
 * What it does:
 *   1. Runs our TypeScript normalizer (normalize<Agent>) on every *.jsonl in
 *      the session-log-dir and merges them into a single trajectory.
 *   2. Shells to /tmp/harbor-spike/venv/bin/python running Harbor's converter
 *      on the same directory.
 *   3. Prints a side-by-side of tool-call histogram, disjoint token totals
 *      (translating Harbor's inclusive prompt buckets), step count, and which
 *      content fields each normalizer populates.
 *
 * Token-bucket translation (Harbor inclusive → disjoint):
 *   Harbor final_metrics carries INCLUSIVE buckets where
 *     total_prompt_tokens = uncached + cached + cache_write
 *   We translate to DISJOINT buckets:
 *     uncached    = total_prompt_tokens − total_cached_tokens − total_cache_creation_input_tokens
 *     cached      = total_cached_tokens
 *     cache_write = total_cache_creation_input_tokens   (from extra)
 *     completion  = total_completion_tokens
 *
 * This script is NOT wired into `bun run check`. Run it manually to validate
 * a normalizer against Harbor after making changes.
 *
 * See scripts/README-harbor-parity.md for full usage guide.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Glob } from 'bun';
import { normalizeAntigravity } from '../src/normalize/antigravity.ts';
import { normalizeClaudeLegacy } from '../src/normalize/claude.ts';
import { normalizeCodex } from '../src/normalize/codex.ts';
import { normalizeCopilot } from '../src/normalize/copilot.ts';
import { normalizeGemini } from '../src/normalize/gemini.ts';
import { normalizeKimi } from '../src/normalize/kimi.ts';
import { normalizeOpencode } from '../src/normalize/opencode.ts';
import { normalizePi } from '../src/normalize/pi.ts';
import type {
  AtifAgent,
  AtifFinalMetrics,
  AtifStep,
  AtifTrajectory,
  ATIF_SCHEMA_VERSION,
} from '../src/atif/types.ts';

const HARBOR_PYTHON = '/tmp/harbor-spike/venv/bin/python';
const AGENT_VERSION = 'unknown';

// ── Normalizer registry ───────────────────────────────────────────────────────

type NormFn = (raw: string, version: string) => AtifTrajectory;

const NORMALIZERS: Record<string, NormFn> = {
  antigravity: normalizeAntigravity,
  claude: normalizeClaudeLegacy,
  codex: normalizeCodex,
  copilot: normalizeCopilot,
  gemini: normalizeGemini,
  kimi: normalizeKimi,
  opencode: normalizeOpencode,
  pi: normalizePi,
};

// ── Harbor final_metrics shape ────────────────────────────────────────────────

/**
 * Harbor's to_json_dict() emits final_metrics with INCLUSIVE token buckets
 * and places total_cached_tokens at the top level (unlike our AtifFinalMetrics
 * which carries cached only in extra). This type reflects what Harbor actually
 * returns so we can translate it correctly.
 */
export interface HarborFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number; // Harbor-specific: at top level, not in extra
  total_steps?: number;
  extra?: {
    total_cache_creation_input_tokens?: number;
    total_cache_read_input_tokens?: number;
    [key: string]: unknown;
  };
}

// ── disjointFromHarbor ────────────────────────────────────────────────────────

/**
 * Harbor final_metrics carries INCLUSIVE prompt buckets:
 *   total_prompt_tokens = uncached_input + cache_read + cache_creation
 *   total_cached_tokens = cache_read (same as total_cache_read_input_tokens)
 *
 * Our ATIF convention uses DISJOINT buckets (no overlap). This helper
 * translates Harbor's inclusive representation to our disjoint one.
 *
 * The formula is validated against the real claude trace
 * results/superpowers-bootstrap-claude-20260616T052827Z-bf6f:
 *   Harbor → 94269 / 71457 / 17118 / 528 (inclusive)
 *   Disjoint → 5694 / 71457 / 17118 / 528 (uncached = 94269 - 71457 - 17118)
 */
export function disjointFromHarbor(harborFinalMetrics: HarborFinalMetrics): {
  uncached: number;
  cached: number;
  cache_write: number;
  completion: number;
} {
  const prompt = harborFinalMetrics.total_prompt_tokens ?? 0;
  const cached = harborFinalMetrics.total_cached_tokens ?? 0;
  const completion = harborFinalMetrics.total_completion_tokens ?? 0;
  const cacheWrite = harborFinalMetrics.extra?.total_cache_creation_input_tokens ?? 0;

  return {
    uncached: prompt - cached - cacheWrite,
    cached,
    cache_write: cacheWrite,
    completion,
  };
}

// ── Our normalizer runner ─────────────────────────────────────────────────────

function runOurNormalizer(agent: string, logDir: string): AtifTrajectory | null {
  const normalize = NORMALIZERS[agent];
  if (!normalize) {
    console.error(`Unknown agent: ${agent}. Valid agents: ${Object.keys(NORMALIZERS).join(', ')}`);
    process.exit(1);
  }

  // Collect session logs — .jsonl for most agents, .json for opencode
  const logs: string[] = [];
  for (const abs of new Glob('**/*.jsonl').scanSync({ cwd: logDir, absolute: true, dot: true })) {
    logs.push(abs);
  }
  for (const abs of new Glob('**/*.json').scanSync({ cwd: logDir, absolute: true, dot: true })) {
    logs.push(abs);
  }

  if (logs.length === 0) {
    console.error(`No session logs found in: ${logDir}`);
    return null;
  }

  // Normalize each log file; merge into one trajectory when multiple logs exist
  const trajectories: AtifTrajectory[] = [];
  for (const logPath of logs.sort()) {
    const raw = readFileSync(logPath, 'utf8');
    if (!raw.trim()) continue;
    try {
      trajectories.push(normalize(raw, AGENT_VERSION));
    } catch (err) {
      console.error(`Warning: failed to normalize ${logPath}: ${err}`);
    }
  }

  if (trajectories.length === 0) return null;
  if (trajectories.length === 1) return trajectories[0] as AtifTrajectory;

  // Merge: concatenate + renumber steps, sum final_metrics
  const allSteps: AtifStep[] = [];
  for (const t of trajectories) {
    for (const s of t.steps) {
      allSteps.push({ ...s, step_id: allSteps.length + 1 });
    }
  }

  const first = trajectories[0] as AtifTrajectory;
  const merged: AtifTrajectory = {
    schema_version: first.schema_version,
    agent: first.agent as AtifAgent,
    steps: allSteps,
  };

  // Sum final_metrics across trajectories
  const fms = trajectories.map((t) => t.final_metrics).filter(
    (fm): fm is AtifFinalMetrics => fm !== undefined,
  );
  if (fms.length > 0) {
    merged.final_metrics = fms.reduce<AtifFinalMetrics>((acc, fm) => ({
      total_prompt_tokens: (acc.total_prompt_tokens ?? 0) + (fm.total_prompt_tokens ?? 0),
      total_completion_tokens:
        (acc.total_completion_tokens ?? 0) + (fm.total_completion_tokens ?? 0),
      total_steps: (acc.total_steps ?? 0) + (fm.total_steps ?? 0),
    }), {});
  }

  return merged;
}

// ── Harbor runner ─────────────────────────────────────────────────────────────

// Inline Python: instantiates Harbor's ClaudeCode converter and emits JSON
const HARBOR_SCRIPT = `
import sys, json
from pathlib import Path
from harbor.agents.installed.claude_code import ClaudeCode

session_dir = Path(sys.argv[1])
conv = ClaudeCode(logs_dir=session_dir, model_name=None)
htraj = conv._convert_events_to_trajectory(session_dir)
if htraj is None:
    print('null')
else:
    print(json.dumps(htraj.to_json_dict()))
`;

function runHarbor(logDir: string): AtifTrajectory | null {
  if (!existsSync(HARBOR_PYTHON)) {
    console.error(
      `Harbor Python not found at ${HARBOR_PYTHON}.\n` +
        `Recreate: uv venv --python 3.12 /tmp/harbor-spike/venv && ` +
        `uv pip install --python /tmp/harbor-spike/venv harbor==0.14.0`,
    );
    return null;
  }

  const result = spawnSync(HARBOR_PYTHON, ['-c', HARBOR_SCRIPT, logDir], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error('Harbor failed:', result.stderr);
    return null;
  }

  const out = result.stdout.trim();
  if (!out || out === 'null') return null;

  try {
    return JSON.parse(out) as AtifTrajectory;
  } catch {
    console.error('Failed to parse Harbor output:', out.slice(0, 200));
    return null;
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

function toolHistogram(traj: AtifTrajectory): Record<string, number> {
  const hist: Record<string, number> = {};
  for (const step of traj.steps) {
    for (const tc of step.tool_calls ?? []) {
      hist[tc.function_name] = (hist[tc.function_name] ?? 0) + 1;
    }
  }
  return hist;
}

function sumStepMetrics(traj: AtifTrajectory): {
  prompt: number;
  cached: number;
  completion: number;
  cache_write: number;
} {
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let cacheWrite = 0;
  for (const step of traj.steps) {
    prompt += step.metrics?.prompt_tokens ?? 0;
    cached += step.metrics?.cached_tokens ?? 0;
    completion += step.metrics?.completion_tokens ?? 0;
    cacheWrite += (step.extra?.['cache_write'] as number | undefined) ?? 0;
  }
  return { prompt, cached, completion, cache_write: cacheWrite };
}

function contentFields(traj: AtifTrajectory): string[] {
  const fields = new Set<string>();
  for (const step of traj.steps) {
    if (step.message) fields.add('message');
    if (step.reasoning_content) fields.add('reasoning_content');
    if (step.tool_calls?.length) fields.add('tool_calls');
    if (step.observation) fields.add('observation');
    if (step.metrics) fields.add('metrics');
    if (step.model_name) fields.add('model_name');
  }
  return [...fields].sort();
}

function printSummary(label: string, traj: AtifTrajectory | null): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label}`);
  console.log(`${'─'.repeat(60)}`);

  if (!traj) {
    console.log('  (no trajectory)');
    return;
  }

  const toolCalls = traj.steps.flatMap((s) => s.tool_calls ?? []);
  const hist = toolHistogram(traj);
  const stepMetrics = sumStepMetrics(traj);
  const fields = contentFields(traj);

  console.log(`  steps: ${traj.steps.length}   tool_calls: ${toolCalls.length}`);
  console.log(`  tool histogram: ${JSON.stringify(hist)}`);
  console.log(`  content fields: ${fields.join(', ')}`);
  console.log();

  // Per-step metrics
  if (Object.values(stepMetrics).some((v) => v > 0)) {
    console.log('  [per-step metrics]');
    console.log(`    uncached (prompt):  ${stepMetrics.prompt}`);
    console.log(`    cached:             ${stepMetrics.cached}`);
    console.log(`    cache_write:        ${stepMetrics.cache_write}`);
    console.log(`    completion:         ${stepMetrics.completion}`);
    console.log(
      `    total:              ${stepMetrics.prompt + stepMetrics.cached + stepMetrics.cache_write + stepMetrics.completion}`,
    );
  }

  // Final metrics — Harbor uses inclusive buckets; ours doesn't
  const fm = traj.final_metrics;
  if (fm) {
    // Cast to Harbor shape to read total_cached_tokens if present
    const fmH = fm as HarborFinalMetrics;
    const hasCached = (fmH.total_cached_tokens ?? 0) > 0 || (fmH.extra?.total_cache_creation_input_tokens ?? 0) > 0;
    console.log('  [final_metrics]');
    if (hasCached) {
      // Harbor format: inclusive buckets
      const disjoint = disjointFromHarbor(fmH);
      console.log('    Harbor inclusive → disjoint:');
      console.log(`      total_prompt (inclusive): ${fmH.total_prompt_tokens ?? 0}`);
      console.log(`      total_cached:             ${fmH.total_cached_tokens ?? 0}`);
      console.log(`      cache_creation (extra):   ${fmH.extra?.total_cache_creation_input_tokens ?? 0}`);
      console.log(`    → uncached:    ${disjoint.uncached}`);
      console.log(`    → cached:      ${disjoint.cached}`);
      console.log(`    → cache_write: ${disjoint.cache_write}`);
      console.log(`    → completion:  ${disjoint.completion}`);
    } else {
      // Our format: already disjoint
      console.log(`    total_prompt_tokens:     ${fm.total_prompt_tokens ?? 0}`);
      console.log(`    total_completion_tokens: ${fm.total_completion_tokens ?? 0}`);
      const extraCached = fm.extra?.['total_cached_tokens'] as number | undefined;
      if (extraCached !== undefined) {
        console.log(`    cached (extra):          ${extraCached}`);
      }
    }
  }
}

// ── Parity comparison ─────────────────────────────────────────────────────────

function printParity(ours: AtifTrajectory | null, harbor: AtifTrajectory | null): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('PARITY CHECK');
  console.log(`${'═'.repeat(60)}`);

  if (!ours || !harbor) {
    console.log('  Cannot compare — one or both trajectories missing.');
    return;
  }

  const ourToolCalls = ours.steps.flatMap((s) => s.tool_calls ?? []);
  const harborToolCalls = harbor.steps.flatMap((s) => s.tool_calls ?? []);
  const ourHist = toolHistogram(ours);
  const harborHist = toolHistogram(harbor);
  const toolMatch = JSON.stringify(ourHist) === JSON.stringify(harborHist);

  console.log(
    `  tool_calls: ours=${ourToolCalls.length} harbor=${harborToolCalls.length} ` +
      (ourToolCalls.length === harborToolCalls.length ? '✓' : '✗ MISMATCH'),
  );
  console.log(`  tool histogram: ${toolMatch ? '✓ MATCH' : '✗ MISMATCH'}`);
  if (!toolMatch) {
    console.log(`    ours:   ${JSON.stringify(ourHist)}`);
    console.log(`    harbor: ${JSON.stringify(harborHist)}`);
  }

  // Token parity: our disjoint per-step sums vs Harbor final_metrics → disjoint
  const ourMetrics = sumStepMetrics(ours);
  const harborFm = harbor.final_metrics as HarborFinalMetrics | undefined;

  if (harborFm) {
    const harborDisjoint = disjointFromHarbor(harborFm);
    const ourTotal =
      ourMetrics.prompt + ourMetrics.cached + ourMetrics.cache_write + ourMetrics.completion;
    const harborTotal =
      harborDisjoint.uncached +
      harborDisjoint.cached +
      harborDisjoint.cache_write +
      harborDisjoint.completion;

    const chk = (a: number, b: number) => (a === b ? '✓' : '✗ MISMATCH');

    console.log('\n  token parity (ours per-step vs Harbor final_metrics disjoint):');
    console.log(
      `    uncached:    ours=${ourMetrics.prompt} harbor=${harborDisjoint.uncached} ${chk(ourMetrics.prompt, harborDisjoint.uncached)}`,
    );
    console.log(
      `    cached:      ours=${ourMetrics.cached} harbor=${harborDisjoint.cached} ${chk(ourMetrics.cached, harborDisjoint.cached)}`,
    );
    console.log(
      `    cache_write: ours=${ourMetrics.cache_write} harbor=${harborDisjoint.cache_write} ${chk(ourMetrics.cache_write, harborDisjoint.cache_write)}`,
    );
    console.log(
      `    completion:  ours=${ourMetrics.completion} harbor=${harborDisjoint.completion} ${chk(ourMetrics.completion, harborDisjoint.completion)}`,
    );
    console.log(
      `    total:       ours=${ourTotal} harbor=${harborTotal} ${chk(ourTotal, harborTotal)}`,
    );

    // Also compare our final_metrics if present (agents that use final_metrics path)
    const ourFm = ours.final_metrics;
    if (ourFm) {
      const ourFmPrompt = ourFm.total_prompt_tokens ?? 0;
      const ourFmCompletion = ourFm.total_completion_tokens ?? 0;
      console.log('\n  our final_metrics vs Harbor final_metrics disjoint:');
      console.log(
        `    prompt:     ours=${ourFmPrompt} harbor=${harborDisjoint.uncached} ${chk(ourFmPrompt, harborDisjoint.uncached)}`,
      );
      console.log(
        `    completion: ours=${ourFmCompletion} harbor=${harborDisjoint.completion} ${chk(ourFmCompletion, harborDisjoint.completion)}`,
      );
    }
  } else {
    const ourTotal =
      ourMetrics.prompt + ourMetrics.cached + ourMetrics.cache_write + ourMetrics.completion;
    console.log('\n  Harbor has no final_metrics — cannot compare token totals.');
    console.log(`  our per-step total: ${ourTotal}`);
  }
}

// ── Main CLI ──────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun scripts/harbor-parity.ts <agent> <session-log-dir>');
    console.log();
    console.log('Agents:', Object.keys(NORMALIZERS).join(', '));
    console.log();
    console.log('Example (claude):');
    console.log(
      '  bun scripts/harbor-parity.ts claude ' +
        'results/superpowers-bootstrap-claude-*/home/.claude/projects/*/',
    );
    process.exit(args.length < 2 ? 1 : 0);
  }

  const agent = args[0];
  const logDirRaw = args[1];

  if (!agent || !logDirRaw) {
    console.error('Both <agent> and <session-log-dir> are required.');
    process.exit(1);
  }

  const logDir = resolve(logDirRaw);

  if (!existsSync(logDir)) {
    console.error(`Session log dir does not exist: ${logDir}`);
    process.exit(1);
  }

  console.log(`Harbor-parity validation: agent=${agent}`);
  console.log(`Log dir: ${logDir}`);

  const ours = runOurNormalizer(agent, logDir);
  const harbor = runHarbor(logDir);

  printSummary('OUR NORMALIZER', ours);
  printSummary('HARBOR CONVERTER', harbor);
  printParity(ours, harbor);
  console.log();
}

// Only run as CLI when this file is the entrypoint, not when imported as a module.
if (import.meta.main) {
  main();
}

// Best-effort run provenance (PRI-2494): what exactly was under test. Every
// probe is fallible and independent — a probe failure yields null for that
// field and MUST NOT fail the run. Stamped into verdict.json by runScenario;
// renderers may ignore it. It exists so a run dir can answer "which
// superpowers rev / agent CLI / gauntlet produced this verdict" (triage,
// longitudinal baselines, commit-per-skill bisection).

import { spawnSync } from 'node:child_process';
import { envSnapshot, getEnv } from '../env.ts';

export interface RunProvenance {
  superpowers_rev: string | null;
  superpowers_dirty: boolean | null;
  harness_rev: string | null;
  agent_cli_version: string | null;
  gauntlet_version: string | null;
}

export function collectProvenance(args: {
  repoRoot: string;
  agentBinary: string | null;
}): RunProvenance {
  const sproot = getEnv('SUPERPOWERS_ROOT');
  return {
    superpowers_rev: sproot ? gitRev(sproot) : null,
    superpowers_dirty: sproot ? gitDirty(sproot) : null,
    harness_rev: gitRev(args.repoRoot),
    agent_cli_version: args.agentBinary ? versionLine(args.agentBinary) : null,
    gauntlet_version: versionLine('gauntlet'),
  };
}

function gitRev(cwd: string): string | null {
  const out = run('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return out === null ? null : out.trim() || null;
}

function gitDirty(cwd: string): boolean | null {
  const out = run('git', ['-C', cwd, 'status', '--porcelain']);
  return out === null ? null : out.trim() !== '';
}

// First line of `<binary> --version`; null when the binary is missing,
// exits nonzero, or prints nothing.
function versionLine(binary: string): string | null {
  const out = run(binary, ['--version']);
  if (out === null) return null;
  const line = out.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

// Run a probe; null on spawn error or nonzero exit. 10s timeout so a hung
// probe cannot stall the verdict write.
function run(cmd: string, args: string[]): string | null {
  try {
    const p = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 10_000,
      env: envSnapshot(),
    });
    if (p.error || (p.status ?? 1) !== 0) return null;
    return p.stdout ?? '';
  } catch {
    return null;
  }
}

// Best-effort run provenance (PRI-2494): what exactly was under test. Every
// probe is fallible and independent — a probe failure yields null for that
// field and MUST NOT fail the run. Stamped into verdict.json by runScenario;
// renderers may ignore it. It exists so a run dir can answer "which
// superpowers rev / agent CLI / gauntlet produced this verdict" (triage,
// longitudinal baselines, commit-per-skill bisection).
//
// superpowers_rev/superpowers_dirty are normally read by running `git` here,
// in-container, against SUPERPOWERS_ROOT (bind-mounted to /workspace/superpowers).
// That breaks for a LINKED git worktree (`git worktree add`): its `.git` is a
// file containing a `gitdir:` pointer into the primary checkout's
// `.git/worktrees/<name>` on the host, a path that is never mounted into the
// container, so the in-container `git rev-parse` fails and both fields go
// null. scripts/evals-container resolves the rev (and dirty flag) on the HOST
// side at `up` time — where the primary checkout's .git is reachable
// regardless of worktree layout — and passes them in as
// QUORUM_SUPERPOWERS_REV / QUORUM_SUPERPOWERS_DIRTY. Those env overrides win
// when present; the in-container git probe remains the fallback for direct
// (non-evals-container) invocations and normal, non-worktree checkouts.

import { spawnSync } from 'node:child_process';
import { getEnv } from '../env.ts';

export interface RunProvenance {
  superpowers_rev: string | null;
  superpowers_dirty: boolean | null;
  harness_rev: string | null;
  agent_cli_version: string | null;
  gauntlet_version: string | null;
  // Where the run actually executed (process.platform: 'darwin' | 'linux' |
  // 'win32'). The verdict's top-level `os` field is the run TARGET (defaulted
  // 'linux', also the host-vs-guest discriminator), which mislabels local
  // darwin runs; this field records ground truth.
  host_platform: string;
}

export function collectProvenance(args: {
  repoRoot: string;
  agentBinary: string | null;
}): RunProvenance {
  const sproot = getEnv('SUPERPOWERS_ROOT');
  return {
    superpowers_rev: sproot ? (hostRev() ?? gitRev(sproot)) : null,
    superpowers_dirty: sproot ? (hostDirty() ?? gitDirty(sproot)) : null,
    harness_rev: gitRev(args.repoRoot),
    agent_cli_version: args.agentBinary ? versionLine(args.agentBinary) : null,
    gauntlet_version: versionLine('gauntlet'),
    host_platform: process.platform,
  };
}

// QUORUM_SUPERPOWERS_REV, when set to a non-empty value, is a host-resolved
// override for superpowers_rev (see the file header). Anything else (unset,
// empty) defers to the in-container probe.
function hostRev(): string | null {
  const rev = getEnv('QUORUM_SUPERPOWERS_REV');
  return rev && rev.trim() !== '' ? rev.trim() : null;
}

// QUORUM_SUPERPOWERS_DIRTY, when set to exactly "true" or "false", is a
// host-resolved override for superpowers_dirty. Anything else defers to the
// in-container probe.
function hostDirty(): boolean | null {
  const dirty = getEnv('QUORUM_SUPERPOWERS_DIRTY');
  if (dirty === 'true') return true;
  if (dirty === 'false') return false;
  return null;
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

// The probe children's env (F13): git plus the agent/gauntlet version binaries
// are real subprocesses, so they get a non-secret projection, never the host
// provider bundle. The retained names are the probes' own routing:
//   PATH — structural: spawnSync resolves the bare binary name through the
//     child env's PATH.
//   HOME / XDG_CONFIG_HOME — git's documented config resolution runs on every
//     command (~/.gitconfig and $XDG_CONFIG_HOME/git/config carry
//     safe.directory / includeIf, which container hosts rely on for the
//     rev/dirty probes), and the version binaries read their own config the
//     same way.
// Probes are best-effort by design (a failure nulls one field, never the run),
// so a too-tight list degrades a provenance field silently rather than loudly —
// which is why the routing trio stays in while everything else stays out.
const PROBE_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'XDG_CONFIG_HOME'];

function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PROBE_ENV_ALLOWLIST) {
    const value = getEnv(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// Run a probe; null on spawn error or nonzero exit. 10s timeout so a hung
// probe cannot stall the verdict write.
function run(cmd: string, args: string[]): string | null {
  try {
    const p = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 10_000,
      env: probeEnv(),
    });
    if (p.error || (p.status ?? 1) !== 0) return null;
    return p.stdout ?? '';
  } catch {
    return null;
  }
}

import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { readBundleEnvForProjection } from '../appliance/credential-scope.ts';
import { inspectLock } from '../appliance/locks.ts';
import type { LoadedApplianceStateConfig } from '../appliance/types.ts';
import {
  acquireLiveSpendLock,
  type HeartbeatScheduler,
  realProcessIdentityProbe,
} from '../campaign/locks.ts';
import {
  APPLIANCE_SCOPED_GRADER_MODE,
  QUORUM_GRADER_SOURCE_MODE,
  SUPERVISOR_NETWORK_ENV_NAMES,
} from '../credentials/grader.ts';
import { getEnv } from '../env.ts';
import { RealClock } from '../scheduler/clock.ts';
import { gauntletEnvBase } from './gauntlet-env.ts';

const CHILD_MS = 120_000;
const CLEANUP_MS = 2_000;
const MANTLE_URL = 'https://bedrock-mantle.us-east-1.api.aws/anthropic';
const SYSTEM_ENV = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;
export type ChildOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: boolean;
};
/** Every termination waits for child close, retaining the external two-minute bound. */
export async function runChild(options: {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ChildOutcome> {
  const cancellationSignal = (): NodeJS.Signals =>
    options.signal.reason === 'cancelled:SIGINT' ? 'SIGINT' : 'SIGTERM';
  if (options.signal.aborted)
    return {
      code: null,
      signal: cancellationSignal(),
      timedOut: false,
      spawnError: false,
    };
  const logs: number[] = [];
  try {
    const stdout = openSync(join(options.cwd, 'child.stdout.log'), 'wx', 0o600);
    logs.push(stdout);
    const stderr = openSync(join(options.cwd, 'child.stderr.log'), 'wx', 0o600);
    logs.push(stderr);
    let spawnFailure: Error | undefined;
    const outcome = await new Promise<ChildOutcome>((done) => {
      const child = spawn(process.execPath, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', stdout, stderr],
      });
      let timedOut = false;
      let spawnError = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = (signal: NodeJS.Signals) => {
        child.kill(signal);
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), CLEANUP_MS);
      };
      const abort = () => terminate(cancellationSignal());
      options.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
      }, options.timeoutMs ?? CHILD_MS);
      child.once('error', (error) => {
        spawnError = true;
        spawnFailure = error;
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        options.signal.removeEventListener('abort', abort);
        done({ code, signal, timedOut, spawnError });
      });
      if (options.signal.aborted) abort();
    });
    if (spawnFailure) writeFileSync(stderr, `${inspect(spawnFailure)}\n`);
    return outcome;
  } finally {
    for (const fd of logs) closeSync(fd);
  }
}

/** Keep ownership loss inside the operator cancellation path. */
export function createRoleHeartbeatScheduler(
  lost: () => void,
): HeartbeatScheduler {
  return {
    every(ms, beat) {
      const timer = setInterval(() => {
        try {
          beat();
        } catch {
          lost();
        }
      }, ms);
      return () => clearInterval(timer);
    },
  };
}

/** Project the blessed retained-assessment credential and network policy. */
export function retainedRoleEnv(
  bundlePath: string,
  pricingDirectory: string,
): Record<string, string | undefined> {
  const names = ['AWS_BEARER_TOKEN_BEDROCK', ...SUPERVISOR_NETWORK_ENV_NAMES];
  const bundle = readBundleEnvForProjection(bundlePath, names);
  const bearer = bundle.get('AWS_BEARER_TOKEN_BEDROCK');
  if (!bearer) throw new Error('blessed bundle has no Bedrock bearer');
  const source: Record<string, string | undefined> = {
    [QUORUM_GRADER_SOURCE_MODE]: APPLIANCE_SCOPED_GRADER_MODE,
    QUORUM_GRADER_ANTHROPIC_API_KEY: bearer,
    QUORUM_GRADER_ANTHROPIC_BASE_URL: MANTLE_URL,
  };
  for (const name of SYSTEM_ENV) source[name] = getEnv(name);
  for (const name of SUPERVISOR_NETWORK_ENV_NAMES)
    source[name] = bundle.get(name);
  return {
    ...gauntletEnvBase(source),
    OBOL_PRICING_DIR: pricingDirectory,
  };
}

/** Qualification cannot reclaim an ordinary operation or an unresolved campaign. */
export function acquireQualificationLease(
  loaded: LoadedApplianceStateConfig,
  lost: () => void,
) {
  for (const name of ['run.lock', 'sync.lock']) {
    const lock = inspectLock(join(loaded.paths.locks, name));
    if (lock.state !== 'missing')
      throw new Error(`${name} is ${lock.state}; qualification refused`);
  }
  if (!loaded.config.live_spend_lock)
    throw new Error('qualification requires configured live-spend lock');
  return acquireLiveSpendLock({
    lockPath: loaded.config.live_spend_lock,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
    scheduler: createRoleHeartbeatScheduler(lost),
  });
}

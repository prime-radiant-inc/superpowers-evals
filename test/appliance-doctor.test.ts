import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { doctorPayload } from '../src/appliance/doctor.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];

  result: CommandResult = {
    status: 0,
    stdout: 'quorum-appliance: exists, running\n',
    stderr: '',
  };

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    return this.result;
  }
}

function loaded(): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-doctor-'));
  for (const dir of [
    'superpowers-evals',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    configPath: join(root, 'config/appliance.json'),
    config: {
      root,
      evals: {
        path: join(root, 'superpowers-evals'),
        remote: 'origin',
        ref: 'main',
      },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'superpowers-evals/results'),
      },
    },
    bundle: {
      bundle_id: 'bundle-1',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic'],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

describe('appliance doctor', () => {
  test('reports config, locks, bundle, and skips missing container helper', () => {
    const cfg = loaded();
    const runner = new FakeRunner();

    const payload = doctorPayload(cfg, runner);

    expect(payload.ok).toBe(true);
    expect(payload.config_path).toBe(cfg.configPath);
    expect(payload.evals_ref).toBe('main');
    expect(payload.credential_bundle.bundle_id).toBe('bundle-1');
    expect(payload.locks.run.state).toBe('missing');
    expect(payload.container.state).toBe('not_checked');
    expect(runner.calls).toEqual([]);
  });

  test('runs container status when helper exists and fails closed on errors', () => {
    const cfg = loaded();
    const runner = new FakeRunner();
    mkdirSync(join(cfg.config.evals.path, 'scripts'), { recursive: true });
    writeFileSync(join(cfg.config.evals.path, 'scripts/evals-container'), '');

    const payload = doctorPayload(cfg, runner);

    expect(payload.container).toEqual({
      state: 'running',
      detail: 'quorum-appliance: exists, running',
    });
    expect(runner.calls[0]?.args).toEqual([
      '--name',
      'quorum-appliance',
      'status',
    ]);

    runner.result = {
      status: 1,
      stdout: '',
      stderr: 'container bad\n',
    };
    expect(() => doctorPayload(cfg, runner)).toThrow(ApplianceError);
  });
});

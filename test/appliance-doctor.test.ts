import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // The docker exec --env-file capability probe (docker exec --help).
  dockerHelpResult: CommandResult = {
    status: 0,
    stdout: 'Usage: docker exec\n  --env-file list\n',
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
    if (command === 'docker') {
      return this.dockerHelpResult;
    }
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
    expect(payload.docker.exec_env_file).toBe(true);
    // Only the docker capability probe runs; the missing wrapper is skipped.
    expect(runner.calls).toEqual([
      { command: 'docker', args: ['exec', '--help'] },
    ]);
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

  test('reports the docker exec --env-file capability honestly and never throws for it', () => {
    const cfg = loaded();

    const unsupported = new FakeRunner();
    unsupported.dockerHelpResult = {
      status: 0,
      stdout: 'Usage: docker exec\n  --env list\n',
      stderr: '',
    };
    expect(doctorPayload(cfg, unsupported).docker.exec_env_file).toBe(false);

    const probeFailed = new FakeRunner();
    probeFailed.dockerHelpResult = {
      status: 1,
      stdout: '',
      stderr: 'docker: command not found\n',
    };
    expect(doctorPayload(cfg, probeFailed).docker.exec_env_file).toBe(false);

    const supported = new FakeRunner();
    expect(doctorPayload(cfg, supported).docker.exec_env_file).toBe(true);
  });
});

// Doctor is credential-aware (it reports validated bundle METADATA), but the
// payload files are never opened: a dangling credentials.env symlink cannot
// break it. Bundle-metadata faults themselves fail typed in the
// credential-aware loader before doctorPayload ever runs (appliance-config
// tests pin that refusal).
describe('doctor bundle access', () => {
  test('doctorPayload never opens bundle payload files', () => {
    const cfg = loaded();
    symlinkSync(
      join(cfg.config.root, 'nowhere'),
      join(cfg.config.credential_bundle.path, 'credentials.env'),
    );
    const payload = doctorPayload(cfg, new FakeRunner());
    expect(payload.ok).toBe(true);
    expect(payload.credential_bundle.bundle_id).toBe('bundle-1');
  });
});

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeBinDir(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'winvm-'));
  const log = join(dir, 'calls.log');
  for (const name of ['docker', 'sshpass', 'rsync']) {
    const p = join(dir, name);
    writeFileSync(
      p,
      `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(p, 0o755);
  }
  return { dir, log };
}

const script = join(import.meta.dir, '..', 'scripts', 'evals-windows-vm');

function run(args: string[], bin: string, log: string) {
  return spawnSync('bash', [script, ...args], {
    env: {
      ...Bun.env,
      PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
      WIN_EVAL_CONTAINER: 'windows11',
      WIN_EVAL_PASSWORD: 'password',
      EVALS_WINVM_CALL_LOG: log,
    },
    encoding: 'utf8',
  });
}

describe('evals-windows-vm', () => {
  test('status calls docker inspect on the configured container', () => {
    const { dir, log } = fakeBinDir();
    const res = run(['status'], dir, log);
    expect(res.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(
      'docker container inspect windows11',
    );
  });

  test('ssh issues a mux-off ssh to the guest', () => {
    const { dir, log } = fakeBinDir();
    run(['ssh', 'whoami'], dir, log);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('sshpass');
    expect(calls).toContain('ControlMaster=no');
    expect(calls).toContain('whoami');
  });
});

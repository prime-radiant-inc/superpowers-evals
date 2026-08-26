import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig } from '../src/contracts/agent-config.ts';

// Pin (or clear) one env name around `body`, snapshotting and restoring the
// prior host value even on throw — an originally-unset name is restored by
// deleting it, never by writing an empty string.
function withEnv(
  name: string,
  value: string | undefined,
  body: () => void,
): void {
  const prev = process.env[name];
  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    body();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

// Minimal valid claude-family YAML (claude requires default_credential;
// model is optional, but a declared blank model is rejected — see
// test/agent-config.test.ts's fixtures), with the caller's required_env
// list.
function agentDir(requiredEnv: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(
    join(dir, 'testagent.yaml'),
    [
      'name: testagent',
      'runtime_family: claude',
      'model: claude-test',
      'default_credential: opus',
      'binary: claude',
      'home_config_subdir: ".claude"',
      'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
      'session_log_glob: "**/*.jsonl"',
      'normalizer: claude',
      `required_env: [${requiredEnv.join(', ')}]`,
      '',
    ].join('\n'),
  );
  return dir;
}

test('effective env satisfies a SUPERPOWERS_ROOT requirement with ambient unset', () => {
  withEnv('SUPERPOWERS_ROOT', undefined, () => {
    const dir = agentDir(['SUPERPOWERS_ROOT']);
    const cfg = loadAgentConfig(dir, 'testagent', {
      env: (key) => (key === 'SUPERPOWERS_ROOT' ? '/wt/abc' : process.env[key]),
    });
    expect(cfg.name).toBe('testagent');
  });
});

test('suppressRequired excludes SUPERPOWERS_ROOT with ambient unset', () => {
  withEnv('SUPERPOWERS_ROOT', undefined, () => {
    const dir = agentDir(['SUPERPOWERS_ROOT']);
    const cfg = loadAgentConfig(dir, 'testagent', {
      suppressRequired: ['SUPERPOWERS_ROOT'],
    });
    expect(cfg.name).toBe('testagent');
  });
});

// The expected message is the loader's full error string — with suppression
// applied, SUPERPOWERS_ROOT must not appear in the missing list at all.
test('other required vars are still enforced against the effective env', () => {
  withEnv('SUPERPOWERS_ROOT', undefined, () => {
    withEnv('SOME_OTHER_KEY', undefined, () => {
      const dir = agentDir(['SUPERPOWERS_ROOT', 'SOME_OTHER_KEY']);
      expect(() =>
        loadAgentConfig(dir, 'testagent', {
          env: (key) =>
            key === 'SUPERPOWERS_ROOT' ? '/wt/abc' : process.env[key],
          suppressRequired: ['SUPERPOWERS_ROOT'],
        }),
      ).toThrow(
        `${join(dir, 'testagent.yaml')}: required env vars not set: SOME_OTHER_KEY`,
      );
    });
  });
});

test('no opts: ambient check unchanged (legacy)', () => {
  withEnv('SOME_OTHER_KEY', undefined, () => {
    const dir = agentDir(['SOME_OTHER_KEY']);
    expect(() => loadAgentConfig(dir, 'testagent')).toThrow(
      `${join(dir, 'testagent.yaml')}: required env vars not set: SOME_OTHER_KEY`,
    );
  });
});

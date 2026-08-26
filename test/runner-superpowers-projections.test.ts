import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/checks/index.ts';
import { runSetup } from '../src/setup-step.ts';

// Pin (or clear) ambient SUPERPOWERS_ROOT around `body`, snapshotting and
// restoring the prior host value even on throw — the withRoot pattern from
// test/agents-superpowers.test.ts. This file sits outside biome's
// noProcessEnv exemption globs, so each direct process.env line carries a
// suppression comment.
async function withAmbientRoot(
  value: string | undefined,
  body: () => void | Promise<void>,
): Promise<void> {
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prev = process.env['SUPERPOWERS_ROOT'];
  try {
    if (value === undefined) {
      // biome-ignore lint/style/noProcessEnv: clear ambient for the assertions
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      // biome-ignore lint/style/noProcessEnv: pin ambient for the assertions
      process.env['SUPERPOWERS_ROOT'] = value;
    }
    await body();
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      process.env['SUPERPOWERS_ROOT'] = prev;
    }
  }
}

function scenarioRecordingEnv(): { dir: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = join(dir, 'env.out');
  writeFileSync(
    join(dir, 'setup.sh'),
    `#!/usr/bin/env bash\nprintf 'SUPERPOWERS_ROOT=%s\\n' "\${SUPERPOWERS_ROOT-<unset>}" > "$QUORUM_SCENARIO_DIR/env.out"\n`,
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return { dir, out };
}

test('setup projection: root mode overrides the allowlist read', async () => {
  await withAmbientRoot('/ambient/sp', () => {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(
      dir,
      mkdtempSync(join(tmpdir(), 'wd-')),
      {},
      {
        mode: 'root',
        root: '/wt/abc',
      },
    );
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/wt/abc\n');
  });
});

test('setup projection: none mode strips SUPERPOWERS_ROOT', async () => {
  await withAmbientRoot('/ambient/sp', () => {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(dir, mkdtempSync(join(tmpdir(), 'wd-')), {}, { mode: 'none' });
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=<unset>\n');
  });
});

test('setup projection: undefined preserves legacy ambient behavior', async () => {
  await withAmbientRoot('/ambient/sp', () => {
    const { dir, out } = scenarioRecordingEnv();
    runSetup(dir, mkdtempSync(join(tmpdir(), 'wd-')));
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/ambient/sp\n');
  });
});

test('checks projection: root overrides, none strips', async () => {
  await withAmbientRoot('/ambient/sp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scn-'));
    const out = join(dir, 'checks-env.out');
    writeFileSync(
      join(dir, 'checks.sh'),
      `pre() { printf 'SUPERPOWERS_ROOT=%s\\n' "\${SUPERPOWERS_ROOT-<unset>}" > "${out}"; }\npost() { :; }\n`,
    );
    const base = {
      checksSh: join(dir, 'checks.sh'),
      phase: 'pre' as const,
      workdir: mkdtempSync(join(tmpdir(), 'wd-')),
      repoRoot: join(import.meta.dir, '..'),
    };
    const root = await runPhase({
      ...base,
      superpowers: { mode: 'root', root: '/wt/abc' },
    });
    expect(root.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=/wt/abc\n');
    const none = await runPhase({ ...base, superpowers: { mode: 'none' } });
    expect(none.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('SUPERPOWERS_ROOT=<unset>\n');
  });
});

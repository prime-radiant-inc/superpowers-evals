import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellSingleQuote } from '../../src/agents/index.ts';

// The runner projects the gauntlet child env onto GAUNTLET_ENV_ALLOWLIST, so a
// MOCK_GAUNTLET_FIXTURE exported by a test process can never survive into the
// spawned child. The fixture selection instead rides inside a generated
// `gauntlet` shim that exports the var itself before exec'ing the mock — PATH
// (which IS on the allowlist) carries the selection, exactly like the real
// gauntlet binary carries its own behavior. The static test/mock-gauntlet/
// gauntlet shim stays for PATH-presence-only uses (test/runner-guards.test.ts).
//
// Env capture is OPT-IN and finite: only when `captureEnvKeys` is given does
// the shim export MOCK_GAUNTLET_ENV_KEYS, and the mock then serializes ONLY
// those keys (never a full env dump — a full dump could persist a real grader
// token from the projected env). Callers own removing the returned dir.
export function mockGauntletDir(
  fixture: string,
  opts: { captureEnvKeys?: readonly string[]; traceDir?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'mock-gauntlet-'));
  const mock = resolve(import.meta.dir, 'mock-gauntlet.ts');
  const shim = join(dir, 'gauntlet');
  const captureLine =
    opts.captureEnvKeys === undefined
      ? ''
      : `export MOCK_GAUNTLET_ENV_KEYS=${shellSingleQuote(opts.captureEnvKeys.join(','))}\n`;
  const traceLine =
    opts.traceDir === undefined
      ? ''
      : `if [ "\${1-}" = run ]; then\n` +
        `  { : > ${shellSingleQuote(join(opts.traceDir, 'shell-entry'))}; } 2>/dev/null || :\n` +
        `  export MOCK_GAUNTLET_TRACE_DIR=${shellSingleQuote(opts.traceDir)}\n` +
        `fi\n`;
  writeFileSync(
    shim,
    '#!/usr/bin/env bash\n' +
      `export MOCK_GAUNTLET_FIXTURE=${shellSingleQuote(fixture)}\n` +
      captureLine +
      traceLine +
      `exec bun ${shellSingleQuote(mock)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

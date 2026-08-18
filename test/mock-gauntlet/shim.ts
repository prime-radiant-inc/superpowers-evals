import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The runner projects the gauntlet child env onto GAUNTLET_ENV_ALLOWLIST, so a
// MOCK_GAUNTLET_FIXTURE exported by a test process can never survive into the
// spawned child. The fixture selection instead rides inside a generated
// `gauntlet` shim that exports the var itself before exec'ing the mock — PATH
// (which IS on the allowlist) carries the selection, exactly like the real
// gauntlet binary carries its own behavior. The static test/mock-gauntlet/
// gauntlet shim stays for PATH-presence-only uses (test/runner-guards.test.ts).
export function mockGauntletDir(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mock-gauntlet-'));
  const mock = resolve(import.meta.dir, 'mock-gauntlet.ts');
  const shim = join(dir, 'gauntlet');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nexport MOCK_GAUNTLET_FIXTURE='${fixture}'\nexec bun '${mock}' "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

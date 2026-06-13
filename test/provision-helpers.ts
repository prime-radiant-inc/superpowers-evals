import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunHome } from '../src/agents/index.ts';

// Create an isolated RunHome under the OS temp dir for adapter provisioning
// tests. configDir is NOT pre-created (the adapter creates it); workdir is the
// run root. Returns the home plus a cleanup() that removes the temp tree.
export function makeTempHome(overrides?: Partial<RunHome>): {
  home: RunHome;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'quorum-provision-'));
  const home: RunHome = {
    configDir: join(root, 'coding-agent-config'),
    workdir: join(root, 'coding-agent-workdir'),
    skeletonRoot: undefined,
    ...overrides,
  };
  return {
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

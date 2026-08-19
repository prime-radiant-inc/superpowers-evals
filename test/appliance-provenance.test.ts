import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateConfig } from '../src/appliance/config.ts';
import { provenancePath } from '../src/appliance/provenance.ts';
import type { LoadedApplianceStateConfig } from '../src/appliance/types.ts';

// provenancePath is pure structural path math: it must accept a state-only
// loaded config (no bundle field) and never look at bundle metadata.
test('provenancePath needs only structural state', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prov-')));
  const loaded: LoadedApplianceStateConfig = {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
  expect(provenancePath(loaded, 'job-1')).toBe(
    join(root, 'state/provenance/job-1.json'),
  );
});

// The real structural loader with INVALID bundle metadata on disk still
// resolves provenance paths: recovery reads never touch the bundle.
test('provenancePath works through loadStateConfig with invalid bundle metadata', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-prov-')));
  for (const dir of ['evals/results', 'credentials/blessed']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'credentials/blessed/metadata.json'), 'not json');
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    }),
  );
  const loaded = loadStateConfig(configPath);
  expect(provenancePath(loaded, 'job-77')).toBe(
    join(root, 'state/provenance/job-77.json'),
  );
});

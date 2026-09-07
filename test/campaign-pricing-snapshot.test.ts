import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPricingSnapshot } from '../src/campaign/pricing-snapshot.ts';
import { sha256Hex } from '../src/contracts/campaign/digest.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';
import { twoArmExperiment } from './fixtures/core-comparison/factory.ts';

function pricingFixture() {
  // realpath: on macOS tmpdir() lives under /var -> /private/var, and the
  // snapshot reader refuses symlinked path components by design.
  const evalsRoot = realpathSync(
    mkdtempSync(join(tmpdir(), 'campaign-pricing-')),
  );
  const directory = join(evalsRoot, 'pricing');
  const file = join(directory, 'current.json');
  const bytes = `${JSON.stringify({
    as_of: '2026-09-05',
    namespaces: { litellm: { 'fixture-model': { input: 1, output: 2 } } },
  })}\n`;
  mkdirSync(directory);
  writeFileSync(file, bytes);
  return {
    evalsRoot,
    directory,
    file,
    bytes,
    snapshot: { path: 'pricing/current.json', sha256: sha256Hex(bytes) },
  };
}

test('suite accepts an explicit pricing snapshot and verifies its exact bytes', () => {
  const fixture = pricingFixture();
  const suite = SuiteSchema.parse({
    schema_version: 2,
    name: 'finite_suite',
    comparisons: [{ arm: 'baseline', scenarios: ['scenario'], n: 1 }],
    reserve: 0,
    max_exposure_skew: 10,
    attempt_bounds: { max_attempts: 1, max_time_s: 60 },
    pricing_snapshot: fixture.snapshot,
  });

  expect(suite.pricing_snapshot).toEqual(fixture.snapshot);
  expect(
    verifyPricingSnapshot({
      evalsRoot: fixture.evalsRoot,
      snapshot: fixture.snapshot,
    }),
  ).toEqual({
    file: fixture.file,
    directory: fixture.directory,
    sha256: fixture.snapshot.sha256,
  });
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: fixture.evalsRoot,
      snapshot: { ...fixture.snapshot, sha256: '0'.repeat(64) },
    }),
  ).toThrow(/digest/i);
});

test.each([
  '/pricing/current.json',
  '../pricing/current.json',
  'pricing/../pricing/current.json',
  'pricing\\current.json',
  'pricing/table.json',
])('pricing snapshot rejects non-portable path %s', (path) => {
  const fixture = pricingFixture();
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: fixture.evalsRoot,
      snapshot: { path, sha256: fixture.snapshot.sha256 },
    }),
  ).toThrow();
});

test('pricing snapshot rejects missing, symlinked, and nonregular sources', () => {
  const missing = pricingFixture();
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: missing.evalsRoot,
      snapshot: { ...missing.snapshot, path: 'missing/current.json' },
    }),
  ).toThrow();

  const linkedFile = pricingFixture();
  const linkedDirectory = join(linkedFile.evalsRoot, 'linked-file');
  mkdirSync(linkedDirectory);
  symlinkSync(linkedFile.file, join(linkedDirectory, 'current.json'));
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: linkedFile.evalsRoot,
      snapshot: {
        ...linkedFile.snapshot,
        path: 'linked-file/current.json',
      },
    }),
  ).toThrow(/symlink|regular file/i);

  const linkedAncestor = pricingFixture();
  symlinkSync(
    linkedAncestor.directory,
    join(linkedAncestor.evalsRoot, 'linked'),
  );
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: linkedAncestor.evalsRoot,
      snapshot: { ...linkedAncestor.snapshot, path: 'linked/current.json' },
    }),
  ).toThrow(/symlink|directory/i);

  const nonregular = pricingFixture();
  mkdirSync(join(nonregular.evalsRoot, 'directory', 'current.json'), {
    recursive: true,
  });
  expect(() =>
    verifyPricingSnapshot({
      evalsRoot: nonregular.evalsRoot,
      snapshot: { ...nonregular.snapshot, path: 'directory/current.json' },
    }),
  ).toThrow(/regular file/i);
});

test('pricing snapshot identity participates in the experiment digest', () => {
  const base = twoArmExperiment();
  const first = {
    ...base,
    suite: {
      ...base.suite,
      pricing_snapshot: {
        path: 'pricing/current.json',
        sha256: '1'.repeat(64),
      },
    },
  };
  const changedPath = {
    ...first,
    suite: {
      ...first.suite,
      pricing_snapshot: {
        ...first.suite.pricing_snapshot,
        path: 'frozen/current.json',
      },
    },
  };
  const changedDigest = {
    ...first,
    suite: {
      ...first.suite,
      pricing_snapshot: {
        ...first.suite.pricing_snapshot,
        sha256: '2'.repeat(64),
      },
    },
  };

  expect(experimentDigest(first)).not.toBe(experimentDigest(changedPath));
  expect(experimentDigest(first)).not.toBe(experimentDigest(changedDigest));
});

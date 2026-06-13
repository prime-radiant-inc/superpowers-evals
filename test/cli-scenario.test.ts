import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveScenarioDir,
  scenarioDirFor,
  scenarioName,
} from '../src/cli/scenario.ts';

// The one shared rule used by run / check / new / run-all.

test('scenarioDirFor: a bare name lives under scenariosRoot', () => {
  expect(scenarioDirFor('foo', 'scenarios')).toBe(join('scenarios', 'foo'));
});

test('scenarioDirFor: a path-like arg (bare-name vs prefixed) collapses to the same dir', () => {
  // `foo` and `scenarios/foo` both point at scenarios/foo.
  expect(scenarioDirFor('scenarios/foo', 'scenarios')).toBe(
    scenarioDirFor('foo', 'scenarios'),
  );
});

test('scenarioDirFor: an absolute path is taken as given', () => {
  expect(scenarioDirFor('/abs/foo', 'scenarios')).toBe('/abs/foo');
});

test('resolveScenarioDir resolves an existing dir by bare name or prefixed path', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  mkdirSync(join(root, 'foo'));
  const bare = resolveScenarioDir('foo', root);
  const prefixed = resolveScenarioDir(join(root, 'foo'), root);
  expect(bare).not.toBeUndefined();
  expect(prefixed).not.toBeUndefined();
  // Both resolve to the same scenario directory.
  expect(resolve(bare ?? '')).toBe(resolve(prefixed ?? ''));
});

test('resolveScenarioDir returns undefined for a missing scenario', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  expect(resolveScenarioDir('ghost', root)).toBeUndefined();
});

test('scenarioName strips any path/prefix to the final segment', () => {
  expect(scenarioName('foo')).toBe('foo');
  expect(scenarioName('scenarios/foo')).toBe('foo');
  expect(scenarioName('/abs/scenarios/foo')).toBe('foo');
});

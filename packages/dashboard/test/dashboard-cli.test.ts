import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseArgs } from '../src/index.ts';

test('parseArgs reads flags', () => {
  const a = parseArgs(['--results', 'r', '--port', '9'], '/repo');
  expect(a.resultsDir).toBe('r');
  expect(a.port).toBe(9);
  expect(a.root).toBe('/repo');
  expect(a.manifestPath).toBe(join('/repo', 'r', 'grid-manifest.json'));
});

test('parseArgs defaults when omitted', () => {
  const a = parseArgs([], '/repo');
  expect(a.resultsDir).toBe('results');
  expect(a.port).toBe(8787);
  expect(a.manifestPath).toBe(join('/repo', 'results', 'grid-manifest.json'));
});

test('parseArgs honors explicit --manifest and --root', () => {
  const a = parseArgs(['--root', '/x', '--manifest', '/m/grid.json'], '/repo');
  expect(a.root).toBe('/x');
  expect(a.manifestPath).toBe('/m/grid.json');
});

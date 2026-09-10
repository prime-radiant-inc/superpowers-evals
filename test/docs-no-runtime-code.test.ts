import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { repoRoot } from '../src/paths.ts';

// docs/ holds experiment records, specs, and fixture data. Runtime code lives in
// src/ and scripts/, where the check suite and the appliance own it. The
// operator scripts that grew under docs/experiments in 2026-09 became a second
// launcher next to the Quorum runner; this fence keeps that door shut.
test('no TypeScript under docs/', () => {
  const offenders = [
    ...new Glob('docs/**/*.ts').scanSync({ cwd: repoRoot(), dot: false }),
  ].sort();
  expect(offenders).toEqual([]);
});

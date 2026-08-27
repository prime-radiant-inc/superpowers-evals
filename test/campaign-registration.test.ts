import { expect, test } from 'bun:test';
import {
  assertIdComponent,
  attemptIdOf,
  cellKeyOf,
  comparisonId,
  primaryBlockId,
  primarySampleId,
  RegistrationError,
  rerunInstanceId,
  reserveBlockId,
  reserveSampleId,
} from '../src/campaign/registration.ts';

test('the pinned ID derivation table', () => {
  const cmp = comparisonId(1);
  expect(cmp).toBe('c1');
  const cell = cellKeyOf(cmp, 'sdd-escalates');
  expect(cell).toBe('c1:sdd-escalates');
  expect(primarySampleId(cell, 'claude-sp', 3)).toBe(
    'c1:sdd-escalates:claude-sp:r3',
  );
  expect(primaryBlockId(cell, 3)).toBe('c1:sdd-escalates:b3');
  expect(reserveBlockId(cell, 2)).toBe('c1:sdd-escalates:x2');
  expect(reserveSampleId(cell, 'claude-sp', 2)).toBe(
    'c1:sdd-escalates:claude-sp:x2',
  );
  // Rerun lineage: the successor of B:i1 is B:i2, never B:i1:i2 — the root is
  // the first non-rerun block; seq increments across the root.
  expect(rerunInstanceId('c1:sdd-escalates:b3', 1)).toBe(
    'c1:sdd-escalates:b3:i1',
  );
  expect(rerunInstanceId('c1:sdd-escalates:b3', 2)).toBe(
    'c1:sdd-escalates:b3:i2',
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:r3', 2)).toBe(
    'c1:sdd-escalates:claude-sp:r3:a2',
  );
});

test('ID components outside the pinned grammar reject; ":" never passes', () => {
  expect(() => assertIdComponent('ok-name.x_1', 'scenario name')).not.toThrow();
  expect(() => assertIdComponent('has:colon', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('Upper', 'arm name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('-lead', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('', 'suite name')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1', 'bad:scenario')).toThrow(RegistrationError);
});

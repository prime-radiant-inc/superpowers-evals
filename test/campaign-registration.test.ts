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

test('numeric parameters outside the 1-based positive-integer domain reject', () => {
  expect(() => comparisonId(0)).toThrow(RegistrationError);
  expect(() => comparisonId(-1)).toThrow(RegistrationError);
  expect(() => comparisonId(1.5)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.NaN)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.POSITIVE_INFINITY)).toThrow(
    RegistrationError,
  );
  expect(() => primaryBlockId('c1:sdd-escalates', -1)).toThrow(
    RegistrationError,
  );
  expect(() => reserveBlockId('c1:sdd-escalates', 0)).toThrow(
    RegistrationError,
  );
  expect(() =>
    primarySampleId('c1:sdd-escalates', 'claude-sp', Number.NaN),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:sdd-escalates', 'claude-sp', 1.5)).toThrow(
    RegistrationError,
  );
  expect(() => rerunInstanceId('c1:sdd-escalates:b3', 0)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:r3', -2)).toThrow(
    RegistrationError,
  );
});

test('prebuilt id inputs are shape-validated before interpolation', () => {
  // comparison id into a cell key: must be c<N>, N 1-based, single component.
  expect(() => cellKeyOf('1', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c0', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1:extra', 'sdd-escalates')).toThrow(
    RegistrationError,
  );
  // cell key into block/sample constructors: exactly c<N>:<scenario>.
  expect(() => primaryBlockId('c1', 3)).toThrow(RegistrationError);
  expect(() =>
    primarySampleId('c1:sdd-escalates:extra', 'claude-sp', 3),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:', 'claude-sp', 2)).toThrow(
    RegistrationError,
  );
  // lineage root: the first NON-rerun block — b<N> or x<N>, never :i<N>.
  expect(() => rerunInstanceId('c1:sdd-escalates:b3:i1', 1)).toThrow(
    RegistrationError,
  );
  expect(() => rerunInstanceId('c1:sdd-escalates:q3', 1)).toThrow(
    RegistrationError,
  );
  // sample id into an attempt: cell:arm:r<N> or cell:arm:x<N>.
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp', 2)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:q3', 2)).toThrow(
    RegistrationError,
  );
  // reserve lineage roots and reserve-sample attempts stay in-grammar.
  expect(rerunInstanceId('c1:sdd-escalates:x2', 1)).toBe(
    'c1:sdd-escalates:x2:i1',
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:x2', 1)).toBe(
    'c1:sdd-escalates:claude-sp:x2:a1',
  );
});

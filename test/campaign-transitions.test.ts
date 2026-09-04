import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
  readCommittedTransitions,
  readProjection,
} from '../src/campaign/execution-journal.ts';
import { realProcessIdentityProbe } from '../src/campaign/locks.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import { RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture(connect?: (path: string) => Database) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'execution-journal-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const experiment = twoArmExperiment();
  experiment.input_digest = experimentDigest(experiment);
  initExecutionJournal({ campaignDir: dir, experiment });
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(experiment));
  const writer = ExecutionJournalWriter.elect({
    campaignDir: dir,
    experiment,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
    ...(connect ? { connect } : {}),
  });
  cleanup.push(() => writer.release());
  for (const item of sessionTransitions(experiment))
    writer.commitTransition(item);
  return {
    dir,
    writer,
    experiment,
    activation: transition('block_activated', blockActivation(experiment), 3),
  };
}

test('commits an entire activation and anchors the reopened prefix', () => {
  const fx = fixture();
  const receipt = fx.writer.commitTransition(fx.activation);
  expect(receipt.sequence).toBe(4);
  expect(readProjection(fx.dir).attempts.size).toBe(2);
  expect(readCommittedTransitions(fx.dir).at(-1)).toEqual(receipt);
  expect(fx.writer.commitTransition(fx.activation)).toEqual(receipt);
  expect(readCommittedTransitions(fx.dir)).toHaveLength(4);
});

test('duplicate transition ID with different bytes refuses without changing durable state', () => {
  const fx = fixture();
  fx.writer.commitTransition(fx.activation);
  expect(() =>
    fx.writer.commitTransition({
      ...fx.activation,
      at: '2026-09-04T00:00:04.000Z',
    }),
  ).toThrow();
  expect(readCommittedTransitions(fx.dir)).toHaveLength(4);
});

for (const boundary of [
  'before-insert',
  'after-insert',
  'after-commit',
] as const) {
  test(`${boundary} storage failure reopens to zero or all activation members`, () => {
    let armed = false;
    const fx = fixture((path) => {
      const db = new Database(path);
      return new Proxy(db, {
        get(target, key) {
          if (key === 'exec')
            return (sql: string) => {
              if (armed && boundary === 'after-insert' && sql === 'COMMIT')
                throw new Error('SQLITE_FULL');
              const result = target.exec(sql);
              if (armed && boundary === 'after-commit' && sql === 'COMMIT')
                throw new Error('lost commit acknowledgment');
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    if (boundary === 'before-insert') {
      const db = new Database(join(fx.dir, 'journal.db'));
      db.exec(
        "CREATE TRIGGER fail_insert BEFORE INSERT ON execution_transitions BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL'); END",
      );
      db.close();
    }
    armed = true;
    expect(() => fx.writer.commitTransition(fx.activation)).toThrow();
    expect(readProjection(fx.dir).attempts.size).toBe(
      boundary === 'after-commit' ? 2 : 0,
    );
    expect(() => fx.writer.commitTransition(fx.activation)).toThrow(/poison/i);
  });
}

test('a displaced writer cannot append using its previously validated projection', () => {
  const fx = fixture();
  renameSync(join(fx.dir, 'journal.lease.d'), join(fx.dir, 'displaced'));
  const successor = ExecutionJournalWriter.elect({
    campaignDir: fx.dir,
    experiment: fx.experiment,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  cleanup.push(() => successor.release());
  expect(() => fx.writer.commitTransition(fx.activation)).toThrow();
  expect(readProjection(fx.dir).attempts.size).toBe(0);
});

test('projection and returned transition mutations cannot change writer validation', () => {
  const fx = fixture();
  const view = fx.writer.readProjection();
  view.controller = null;
  view.experiment.runtime_limits.max_time_s = 999;
  const receipt = fx.writer.commitTransition(fx.activation);
  receipt.transition.payload = {} as never;
  expect(readProjection(fx.dir).attempts.size).toBe(2);
  expect(fx.writer.readProjection().experiment.runtime_limits.max_time_s).toBe(
    60,
  );
});

test('foreign journal and changed frozen experiment refuse without writing', () => {
  const fx = fixture();
  const path = join(fx.dir, 'campaign.json');
  const changed = {
    ...fx.experiment,
    registered_by: 'other',
    refs: { ...fx.experiment.refs, evals: '1'.repeat(40) },
  };
  writeFileSync(path, JSON.stringify(changed));
  expect(() => readProjection(fx.dir)).toThrow(/digest/);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'foreign-journal-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'journal.db');
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '1')",
  );
  db.close();
  const before = readFileSync(dbPath);
  expect(() =>
    initExecutionJournal({ campaignDir: dir, experiment: fx.experiment }),
  ).toThrow();
  expect(readFileSync(dbPath)).toEqual(before);
});

test('a dangling journal symlink cannot create a database outside the campaign', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'journal-link-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'foreign.db');
  symlinkSync(target, join(dir, 'journal.db'));
  const experiment = twoArmExperiment();
  experiment.input_digest = experimentDigest(experiment);
  expect(() =>
    initExecutionJournal({ campaignDir: dir, experiment }),
  ).toThrow();
  expect(existsSync(target)).toBe(false);
});
test('the durable transition ID column must agree with its authenticated canonical body', () => {
  const fx = fixture();
  const db = new Database(join(fx.dir, 'journal.db'));
  db.exec(
    "UPDATE execution_transitions SET transition_id = 'foreign-id' WHERE sequence = 1",
  );
  db.close();
  expect(() => readProjection(fx.dir)).toThrow();
});

test('current writer fence refuses released, poisoned and deposed authority before effects', () => {
  const live = fixture();
  expect(() => live.writer.assertCurrentOwner()).not.toThrow();
  live.writer.release();
  expect(() => live.writer.assertCurrentOwner()).toThrow(/released/);
  const poisoned = fixture();
  expect(() =>
    poisoned.writer.commitTransition(
      transition(
        'registered',
        {
          campaign_id: poisoned.experiment.campaign_id,
          input_digest: poisoned.experiment.input_digest,
        },
        9,
      ),
    ),
  ).toThrow();
  expect(() => poisoned.writer.assertCurrentOwner()).toThrow(/poisoned/);
  const deposed = fixture();
  const db = new Database(join(deposed.dir, 'journal.db'));
  db.exec(
    "UPDATE execution_meta SET value = '9999' WHERE key = 'writer_generation'",
  );
  db.close();
  let effects = 0;
  expect(() => {
    deposed.writer.assertCurrentOwner();
    effects++;
  }).toThrow(/deposed/);
  expect(effects).toBe(0);
});

import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverObserverSources,
  indexBoundObserverSource,
  type ObserverBinding,
} from '../src/experiments/observer/binding.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'native-claude-binding-')),
  );
  roots.push(root);
  const home = join(root, 'home');
  const workdir = join(root, 'workdir');
  const transcripts = join(home, '.claude/projects');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: 'capture',
    campaign: null,
    runtime: 'claude',
    dialect: 'claude-jsonl-2.1.209',
    cli_version: '2.1.209',
    home,
    workdir,
    launch_cwd: workdir,
    roots: [
      { id: 'sessions', kind: 'transcripts', path: transcripts },
      { id: 'documents', kind: 'artifacts', path: workdir },
    ],
    phase: 'unbound',
    parent_source_id: null,
    sources: [],
  };
  const raw = readFileSync(
    new URL('./fixtures/claude-2.1.209-native-parent.jsonl', import.meta.url),
    'utf8',
  ).replaceAll('/capture/claude-parent/workdir', workdir);
  return { binding, raw, path: join(transcripts, 'parent.jsonl'), transcripts };
}

test('awaits the first native typed Claude input and then binds its stable source', () => {
  const f = fixture();
  writeFileSync(f.path, `${f.raw.split('\n').slice(0, 2).join('\n')}\n`);
  expect(discoverObserverSources(f.binding).phase).toBe('unbound');
  writeFileSync(f.path, f.raw);
  const bound = discoverObserverSources(f.binding);
  expect(bound.phase).toBe('bound');
  expect(bound.sources[0]!.source.expected_session_id).toBe(
    '9833e854-9a93-4863-877e-994ff7a4b2d6',
  );
  expect(
    indexBoundObserverSource(
      bound,
      bound.sources[0]!.source,
      Buffer.from(f.raw),
    ).identity.conversation,
  ).toBe('parent');
  expect(discoverObserverSources(bound)).toEqual(bound);
});

test('refuses ambiguous Claude sources and foreign or unproven parent identity', () => {
  const f = fixture();
  for (const raw of [
    f.raw.replaceAll('2.1.209', '2.1.210'),
    f.raw.replaceAll(f.binding.workdir, '/other'),
    f.raw.replace('"typed"', '"injected"'),
  ]) {
    writeFileSync(f.path, raw);
    expect(() => discoverObserverSources(f.binding)).toThrow();
  }
  writeFileSync(f.path, f.raw);
  const bound = discoverObserverSources(f.binding);
  expect(() =>
    indexBoundObserverSource(
      bound,
      bound.sources[0]!.source,
      Buffer.from(f.raw.replace('"typed"', '"injected"')),
    ),
  ).toThrow();
  writeFileSync(join(f.transcripts, 'other.jsonl'), f.raw);
  expect(() => discoverObserverSources(f.binding)).toThrow();
});

test('does not hide a second pending Claude transcript behind an established parent', () => {
  const f = fixture();
  writeFileSync(f.path, f.raw);
  writeFileSync(
    join(f.transcripts, 'pending.jsonl'),
    `${f.raw.split('\n')[0]}\n`,
  );
  expect(() => discoverObserverSources(f.binding)).toThrow();
});

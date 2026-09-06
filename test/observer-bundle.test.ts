import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObserverBinding } from '../src/experiments/observer/binding.ts';
import {
  type ObserverBundle,
  readObserverBundle,
} from '../src/experiments/observer/bundle.ts';
import { captureFinalState } from '../src/experiments/observer/final-state.ts';
import { createRawPrefix } from '../src/experiments/observer/raw.ts';
import { validateArtifactReceipt } from '../src/experiments/observer/review.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'observer-bundle-')));
  dirs.push(dir);
  const home = join(dir, 'home');
  const sessions = join(home, '.codex', 'sessions');
  const workdir = join(dir, 'workdir');
  const bundleDir = join(dir, 'bundle');
  for (const path of [sessions, workdir, bundleDir])
    mkdirSync(path, { recursive: true });
  const raw = Buffer.from(
    '{"type":"session_meta","payload":{"id":"session","cwd":"' +
      workdir +
      '","cli_version":"1.0"}}\n',
  );
  const content = Buffer.from([0, 255, 10, 65]);
  writeFileSync(join(sessions, 'parent.jsonl'), raw);
  writeFileSync(join(workdir, 'design.bin'), content);
  const source = {
    source_id: 'parent',
    runtime: 'codex' as const,
    expected_session_id: 'session',
    expected_cwd: workdir,
    expected_cli_version: '1.0',
  };
  const info = statSync(join(sessions, 'parent.jsonl'), { bigint: true });
  const binding: ObserverBinding = {
    schema_version: 2,
    run_id: 'run',
    campaign: null,
    runtime: 'codex',
    dialect: 'codex-jsonl',
    cli_version: '1.0',
    home,
    workdir,
    launch_cwd: workdir,
    roots: [
      { id: 'sessions', kind: 'transcripts', path: sessions },
      { id: 'documents', kind: 'artifacts', path: workdir },
    ],
    phase: 'finalized',
    parent_source_id: 'parent',
    sources: [
      {
        source,
        root_id: 'sessions',
        relative_path: 'parent.jsonl',
        device: info.dev.toString(),
        inode: info.ino.toString(),
        parent_link: null,
      },
    ],
  };
  const receipt = {
    schema_version: 2 as const,
    observation_id: 'observation-1',
    source_prefix: createRawPrefix(source, raw),
    artifact_path: 'design.bin',
    bytes: content.length,
    sha256: digest(content),
    content_base64: content.toString('base64'),
  };
  const members = {
    'parent.jsonl': raw,
    'design.bin': content,
    'receipt.json': Buffer.from(JSON.stringify(receipt)),
  };
  const bundle: ObserverBundle = {
    schema_version: 2,
    binding,
    final_state: captureFinalState(binding.roots),
    files: Object.entries(members).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: digest(bytes),
    })),
    sources: [{ source_id: 'parent', path: 'parent.jsonl' }],
    terminal_artifacts: [
      { root_id: 'documents', relative_path: 'design.bin', path: 'design.bin' },
    ],
    receipts: ['receipt.json'],
    actor_review: null,
    score: null,
    evidence_errors: [
      { code: 'review_unavailable', message: 'Actor review was not recorded.' },
    ],
  };
  for (const [path, bytes] of Object.entries(members))
    writeFileSync(join(bundleDir, path), bytes);
  const save = () =>
    writeFileSync(
      join(bundleDir, 'observer-bundle.json'),
      JSON.stringify(bundle),
    );
  save();
  return { dir, bundleDir, binding, bundle, receipt, save };
}

describe('observer bundle authentication', () => {
  test('authenticates a complete unscored bundle without dereferencing original paths', () => {
    const f = fixture();
    rmSync(f.binding.home, { recursive: true });
    rmSync(f.binding.workdir, { recursive: true });
    expect(readObserverBundle(f.bundleDir).binding.run_id).toBe('run');
    expect(readObserverBundle(f.bundleDir).score).toBeNull();
  });
  test('rejects removed required source instead of accepting a partial bundle', () => {
    const f = fixture();
    rmSync(join(f.bundleDir, 'parent.jsonl'));
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects a final inventory with an omitted directory ancestor', () => {
    const f = fixture();
    mkdirSync(join(f.binding.workdir, 'nested'));
    renameSync(
      join(f.binding.workdir, 'design.bin'),
      join(f.binding.workdir, 'nested', 'design.bin'),
    );
    f.bundle.final_state = captureFinalState(f.binding.roots);
    f.bundle.terminal_artifacts[0]!.relative_path = 'nested/design.bin';
    f.save();
    expect(
      readObserverBundle(f.bundleDir).terminal_artifacts[0]!.relative_path,
    ).toBe('nested/design.bin');
    f.bundle.final_state.nodes = f.bundle.final_state.nodes.filter(
      (node) => node.path !== 'nested',
    );
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects changed member bytes', () => {
    const f = fixture();
    writeFileSync(join(f.bundleDir, 'parent.jsonl'), '{}\n');
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects inode mismatch between bound source and final state', () => {
    const f = fixture();
    f.bundle.binding.sources[0]!.inode = '0';
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects incomplete source or artifact inventories and missing references', () => {
    for (const mutate of [
      (b: ObserverBundle) => {
        b.sources = [];
      },
      (b: ObserverBundle) => {
        b.terminal_artifacts = [];
      },
      (b: ObserverBundle) => {
        b.files.pop();
      },
      (b: ObserverBundle) => {
        b.final_state.roots.pop();
      },
    ]) {
      const f = fixture();
      mutate(f.bundle);
      f.save();
      expect(() => readObserverBundle(f.bundleDir)).toThrow();
    }
  });
  test.each([
    '../escape',
    '/absolute',
    'a//b',
    'a/./b',
    'C:\\escape',
  ])('rejects noncanonical bundle member %s', (path) => {
    const f = fixture();
    f.bundle.files[0]!.path = path;
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects duplicate members and duplicate references', () => {
    for (const mutate of [
      (b: ObserverBundle) => b.files.push(b.files[0]!),
      (b: ObserverBundle) => b.sources.push(b.sources[0]!),
    ]) {
      const f = fixture();
      mutate(f.bundle);
      f.save();
      expect(() => readObserverBundle(f.bundleDir)).toThrow();
    }
  });
  test('refuses symlink members and symlink envelope', () => {
    for (const path of ['parent.jsonl', 'observer-bundle.json']) {
      const f = fixture();
      copyFileSync(join(f.bundleDir, path), join(f.dir, 'outside'));
      rmSync(join(f.bundleDir, path));
      symlinkSync(join(f.dir, 'outside'), join(f.bundleDir, path));
      expect(() => readObserverBundle(f.bundleDir)).toThrow();
    }
  });
  test('rejects absent review without an evidence error', () => {
    const f = fixture();
    f.bundle.evidence_errors = [];
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects behavioral score with evidence errors in an otherwise valid bundle', () => {
    const f = fixture();
    const review = Buffer.from('{"schema_version":2}');
    writeFileSync(join(f.bundleDir, 'review.json'), review);
    f.bundle.files.push({
      path: 'review.json',
      bytes: review.length,
      sha256: digest(review),
    });
    f.bundle.actor_review = 'review.json';
    const score = Buffer.from('{"schema_version":2,"outcome":"fail"}');
    writeFileSync(join(f.bundleDir, 'score.json'), score);
    f.bundle.files.push({
      path: 'score.json',
      bytes: score.length,
      sha256: digest(score),
    });
    f.bundle.score = 'score.json';
    f.bundle.evidence_errors = [];
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).not.toThrow();
    f.bundle.evidence_errors = [
      { code: 'invalid_review', message: 'Review evidence is invalid.' },
    ];
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
  test('rejects altered receipt prefix against frozen source bytes', () => {
    const f = fixture();
    f.receipt.source_prefix.sha256 = 'a'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(f.receipt));
    writeFileSync(join(f.bundleDir, 'receipt.json'), bytes);
    Object.assign(
      f.bundle.files.find((file) => file.path === 'receipt.json')!,
      { bytes: bytes.length, sha256: digest(bytes) },
    );
    f.save();
    expect(() => readObserverBundle(f.bundleDir)).toThrow();
  });
});

describe('artifact receipts', () => {
  test('retains byte-faithful binary content and distinct observations', () => {
    const f = fixture();
    expect(
      Buffer.from(validateArtifactReceipt(f.receipt).content_base64, 'base64'),
    ).toEqual(Buffer.from([0, 255, 10, 65]));
    expect(
      validateArtifactReceipt({ ...f.receipt, observation_id: 'second' })
        .observation_id,
    ).toBe('second');
  });
  test('rejects inconsistent size, digest, noncanonical base64 and path escape', () => {
    const f = fixture();
    for (const changes of [
      { bytes: 0 },
      { sha256: 'a'.repeat(64) },
      { content_base64: '!!' },
      { artifact_path: '../design.bin' },
    ]) {
      expect(() =>
        validateArtifactReceipt({ ...f.receipt, ...changes }),
      ).toThrow();
    }
  });
});

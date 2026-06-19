import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/appliance/config.ts';
import { ApplianceError, toErrorJson } from '../src/appliance/errors.ts';
import { atomicWriteJson } from '../src/appliance/fs.ts';

function fixture(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'appliance-config-'));
  for (const dir of [
    'superpowers-evals',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, 'credentials/blessed/metadata.json'),
    JSON.stringify({
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic', 'openai'],
      note: 'test bundle',
    }),
  );
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: { path: join(root, 'superpowers-evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'credentials/blessed') },
      container: { name: 'quorum-appliance', results_root: join(root, 'superpowers-evals/results') },
    }),
  );
  return { root, configPath };
}

describe('appliance config', () => {
  test('loads host config and bundle metadata', () => {
    const { root, configPath } = fixture();
    const loaded = loadConfig(configPath);
    expect(loaded.config.root).toBe(root);
    expect(loaded.bundle.bundle_id).toBe('blessed-2026-06-18-a');
    expect(loaded.paths.jobs).toBe(join(root, 'state/jobs'));
    expect(loaded.paths.locks).toBe(join(root, 'state/locks'));
    expect(loaded.paths.provenance).toBe(join(root, 'state/provenance'));
  });

  test('rejects a credential bundle name other than blessed', () => {
    const { configPath } = fixture();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    raw.credential_bundle.name = 'personal';
    writeFileSync(configPath, JSON.stringify(raw));
    expect(() => loadConfig(configPath)).toThrow(/blessed/);
  });
});

describe('appliance error json', () => {
  test('serializes stable machine-readable failures', () => {
    const err = new ApplianceError('lock_busy', 'preflight', 'run.lock is held');
    expect(toErrorJson(err)).toEqual({
      ok: false,
      error: {
        code: 'lock_busy',
        step: 'preflight',
        message: 'run.lock is held',
      },
    });
  });
});

describe('atomicWriteJson', () => {
  test('writes parseable json without leaving temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appliance-json-'));
    const path = join(dir, 'record.json');
    atomicWriteJson(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });
});

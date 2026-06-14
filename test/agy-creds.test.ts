import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  backupCredential,
  setCredPathForTesting,
} from '../src/agents/agy-creds.ts';
import { makeTempHome } from './provision-helpers.ts';

function writeJson(p: string, obj: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj), 'utf8');
}

afterEach(() => {
  setCredPathForTesting(null); // restore default cred path
});

describe('backupCredential / verifyOrRestore', () => {
  test('corrupt live creds are restored from backup', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const creds = join(home.configDir, '.gemini', 'oauth_creds.json');
      writeJson(creds, { access_token: 'good', refresh_token: 'r' });
      setCredPathForTesting(creds);

      const b = backupCredential();
      expect(b).not.toBeNull();
      writeFileSync(creds, '{"access_token": "tru', 'utf8'); // half-written kill
      b?.verifyOrRestore();
      expect(JSON.parse(readFileSync(creds, 'utf8')).access_token).toBe('good');
    } finally {
      cleanup();
    }
  });

  test('legitimate (still-valid-JSON) refresh is left alone', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const creds = join(home.configDir, '.gemini', 'oauth_creds.json');
      writeJson(creds, { access_token: 'old', refresh_token: 'r' });
      setCredPathForTesting(creds);

      const b = backupCredential();
      writeJson(creds, { access_token: 'rotated', refresh_token: 'r' });
      b?.verifyOrRestore();
      expect(JSON.parse(readFileSync(creds, 'utf8')).access_token).toBe(
        'rotated',
      );
    } finally {
      cleanup();
    }
  });

  test('restore failure never raises (best-effort teardown)', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const creds = join(home.configDir, '.gemini', 'oauth_creds.json');
      writeJson(creds, { access_token: 'good', refresh_token: 'r' });
      setCredPathForTesting(creds);

      const b = backupCredential();
      writeFileSync(creds, 'corrupt', 'utf8'); // live corrupt -> restore path
      if (b) {
        unlinkSync(b.backup); // backup gone -> copy would raise; must swallow
        expect(() => b.verifyOrRestore()).not.toThrow();
      }
    } finally {
      cleanup();
    }
  });

  test('missing live creds is a noop returning null', () => {
    const { home, cleanup } = makeTempHome();
    try {
      setCredPathForTesting(join(home.configDir, 'nope.json'));
      expect(backupCredential()).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('backup temp file is cleaned up on the valid-JSON path', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const creds = join(home.configDir, '.gemini', 'oauth_creds.json');
      writeJson(creds, { access_token: 'ok', refresh_token: 'r' });
      setCredPathForTesting(creds);

      const b = backupCredential();
      expect(b).not.toBeNull();
      const backupPath = b?.backup ?? '';
      expect(existsSync(backupPath)).toBe(true);
      b?.verifyOrRestore();
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('backup temp file is cleaned up after a restore', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const creds = join(home.configDir, '.gemini', 'oauth_creds.json');
      writeJson(creds, { access_token: 'good', refresh_token: 'r' });
      setCredPathForTesting(creds);

      const b = backupCredential();
      const backupPath = b?.backup ?? '';
      writeFileSync(creds, 'not json at all', 'utf8');
      b?.verifyOrRestore();
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

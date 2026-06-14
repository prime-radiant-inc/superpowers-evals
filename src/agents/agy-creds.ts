import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Protect agy's shared OAuth token around a mid-run kill.
//
// agy reads auth from the live, token-rotating ~/.gemini/oauth_creds.json.
// A SIGKILL during a token refresh (e.g. the mid-run rate-limit kill) can leave
// the file half-written and unparseable, permanently locking the shared account
// (A4 of the agy reliability spec). Back the file up before the run; read it
// back after: if it is now missing or corrupt JSON, restore it. A legitimate
// token refresh changes the bytes but leaves valid JSON — that is left alone.
//
// Port of quorum/agy_creds.py — public API is camelCase TS, the logic matches.

const DEFAULT_CRED_PATH = join(homedir(), '.gemini', 'oauth_creds.json');

// Mutable indirection so tests can point at a temp credential file, mirroring
// the Python tests' monkeypatch of quorum.agy_creds._CRED_PATH.
let credPath: string = DEFAULT_CRED_PATH;

/** Override the credential path (tests only). Pass null to restore the default. */
export function setCredPathForTesting(p: string | null): void {
  credPath = p ?? DEFAULT_CRED_PATH;
}

export interface CredBackup {
  readonly live: string;
  readonly backup: string;
  /**
   * Restore from backup only if the live file is missing or corrupt JSON.
   *
   * Best-effort and never raises — it runs in a teardown `finally` after a
   * possibly-failing run, so it must not mask the in-flight exception. Always
   * cleans up the temp backup file.
   */
  verifyOrRestore(): void;
}

function makeCredBackup(live: string, backup: string): CredBackup {
  return {
    live,
    backup,
    verifyOrRestore(): void {
      let corrupt = true;
      try {
        if (existsSync(live)) {
          JSON.parse(readFileSync(live, 'utf8'));
          corrupt = false; // valid JSON — legitimate refresh or unchanged
        }
      } catch {
        // JSON parse error or read error — treat the live file as corrupt.
      }
      if (corrupt) {
        try {
          copyFileSync(backup, live);
        } catch {
          // best-effort restore; swallow (e.g. backup already gone).
        }
      }
      try {
        unlinkSync(backup);
      } catch {
        // already removed; ignore.
      }
    },
  };
}

/**
 * Copy the live credential to a temp file and return a CredBackup handle.
 *
 * Returns null if the credential file does not exist (nothing to protect; the
 * caller should skip restore logic entirely).
 */
export function backupCredential(): CredBackup | null {
  if (!existsSync(credPath)) {
    return null;
  }
  const tmpBase = mkdtempSync(join(tmpdir(), 'agy_creds_backup_'));
  const backup = join(tmpBase, 'oauth_creds.json');
  copyFileSync(credPath, backup);
  return makeCredBackup(credPath, backup);
}

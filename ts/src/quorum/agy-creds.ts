/**
 * Protect agy's shared OAuth token around a mid-run kill.
 *
 * agy reads auth from the live, token-rotating ~/.gemini/oauth_creds.json.
 * A SIGKILL during a token refresh can leave the file half-written and
 * unparseable, permanently locking the account (A4 of the agy reliability spec).
 * Backup before the run; read-back after: if the file is corrupt, restore it.
 * A legitimate token refresh changes bytes but stays valid JSON — leave it alone.
 *
 * Port of quorum/agy_creds.py — public API is camelCase TS, logic is identical.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CRED_PATH = path.join(os.homedir(), ".gemini", "oauth_creds.json");

// Mutable indirection so tests can point at a temp credential file, mirroring
// the Python tests' monkeypatch of quorum.agy_creds._CRED_PATH.
let _credPath: string = DEFAULT_CRED_PATH;

/** Override the credential path (tests only). Pass null to restore the default. */
export function setCredPathForTesting(p: string | null): void {
  _credPath = p ?? DEFAULT_CRED_PATH;
}

export interface CredBackup {
  live: string;
  backup: string;
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
        if (fs.existsSync(this.live)) {
          JSON.parse(fs.readFileSync(this.live, "utf8"));
          corrupt = false; // valid JSON — legitimate refresh or unchanged
        }
      } catch {
        // JSON parse error or read error — treat as corrupt.
      }
      if (corrupt) {
        try {
          fs.copyFileSync(this.backup, this.live);
        } catch {
          // best-effort restore; swallow (e.g. backup already gone)
        }
      }
      try {
        fs.unlinkSync(this.backup);
      } catch {
        // already removed; ignore
      }
    },
  };
}

/**
 * Copy the live credential to a temp file and return a CredBackup handle.
 *
 * Returns null if the credential file does not exist (nothing to protect;
 * the caller should skip restore logic entirely).
 */
export function backupCredential(): CredBackup | null {
  if (!fs.existsSync(_credPath)) {
    return null;
  }
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy_creds_backup_"));
  const backup = path.join(tmpBase, "oauth_creds.json");
  fs.copyFileSync(_credPath, backup);
  return makeCredBackup(_credPath, backup);
}

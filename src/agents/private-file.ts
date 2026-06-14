import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  openSync,
  writeSync,
} from 'node:fs';

// Write `data` to `path` at mode 0600 through an O_NOFOLLOW-protected open, so a
// pre-placed symlink at the destination cannot redirect the (secret) write to an
// attacker-controlled path. Mirrors the Python secret writers, which all open
// with O_CREAT|O_TRUNC|O_NOFOLLOW and fchmod 0600 (quorum/runner.py
// _write_private_text / _write_gemini_env_file / _write_claude_env_file /
// _write_copilot_env_file). O_NOFOLLOW makes the open fail (ELOOP) when the final
// path component is a symlink, surfacing as a thrown error rather than a
// redirected secret. The parent directory must already exist (the open does not
// create it). Shared by every per-run env/credential writer (codex, gemini,
// claude, copilot).
export function writePrivateFileNoFollow(
  path: string,
  data: string | Buffer,
): void {
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    fsConstants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
}

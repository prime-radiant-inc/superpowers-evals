import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The repo root: the dir holding scenarios/, coding-agents/, src/.
// This module lives at src/paths.ts, so the root is one segment up (../) from
// the module URL. fileURLToPath yields a trailing-slash dir; strip it for a
// clean path with no trailing separator.
// Correct for run-from-source (`bun run quorum`), the only supported path.
// Under a `bun build --compile` single-binary, import.meta.url points inside
// the bundle and this would NOT find the checkout — a compiled deploy needs a
// different repo-root strategy (env var or cwd-relative). Not used today.
export function repoRoot(): string {
  const url = new URL('../', import.meta.url);
  return fileURLToPath(url).replace(/\/$/, '');
}

/** UTC stamp in the form YYYYMMDDTHHMMSSZ. */
export function nowStampUtc(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/** 4 hex chars (2 random bytes). */
export function hexNonce(): string {
  return randomBytes(2).toString('hex');
}

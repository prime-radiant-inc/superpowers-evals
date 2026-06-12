import { randomBytes } from 'node:crypto';

/** UTC stamp matching Python's strftime("%Y%m%dT%H%M%SZ"). */
export function nowStampUtc(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/** 4 hex chars == Python secrets.token_hex(2). */
export function hexNonce(): string {
  return randomBytes(2).toString('hex');
}

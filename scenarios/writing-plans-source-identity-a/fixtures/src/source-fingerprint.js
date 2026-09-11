import { createHash } from 'node:crypto';

export function fingerprintContents(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

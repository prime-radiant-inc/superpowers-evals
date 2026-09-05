import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { readPinnedNoFollowBytes } from '../appliance/credential-scope.ts';
import type { PricingSnapshot } from '../contracts/campaign/suite.ts';
import { PricingSnapshotSchema } from '../contracts/campaign/suite.ts';

export function verifyPricingSnapshot(args: {
  evalsRoot: string;
  snapshot: PricingSnapshot;
}): { file: string; directory: string; sha256: string } {
  const snapshot = PricingSnapshotSchema.parse(args.snapshot);
  const path = snapshot.path;
  const parts = path.split('/');
  if (
    path.includes('\\') ||
    posix.isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path) ||
    posix.normalize(path) !== path ||
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    posix.basename(path) !== 'current.json'
  ) {
    throw new Error(
      'pricing snapshot path must be a portable Evals-relative path ending in current.json',
    );
  }
  const bytes = readPinnedNoFollowBytes(
    args.evalsRoot,
    parts,
    'pricing snapshot',
    true,
  );
  if (bytes === null) throw new Error('pricing snapshot is missing');
  const observed = createHash('sha256').update(bytes).digest('hex');
  if (observed !== snapshot.sha256) {
    throw new Error(
      `pricing snapshot digest mismatch (${observed} != ${snapshot.sha256})`,
    );
  }
  return {
    file: posix.join(args.evalsRoot, path),
    directory: posix.dirname(posix.join(args.evalsRoot, path)),
    sha256: snapshot.sha256,
  };
}

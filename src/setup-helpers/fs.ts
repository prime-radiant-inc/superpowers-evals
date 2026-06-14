// src/setup-helpers/fs.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Port of setup_helpers/base.py:_write — write `content` to <workdir>/<rel>,
// creating parent directories. UTF-8, newlines preserved as written.
export function writeFixtureFile(
  workdir: string,
  rel: string,
  content: string,
): void {
  const path = join(workdir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

// Port of the `workdir.mkdir(parents=True, exist_ok=True)` first action every
// Python create-from-scratch helper runs immediately before `git init -b main`,
// so each helper is self-sufficient when $QUORUM_WORKDIR does not yet exist.
export function ensureWorkdir(workdir: string): void {
  mkdirSync(workdir, { recursive: true });
}

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

// src/setup-helpers/fs.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Write `content` to <workdir>/<rel>, creating parent directories. UTF-8,
// newlines preserved as written.
export function writeFixtureFile(
  workdir: string,
  rel: string,
  content: string,
): void {
  const path = join(workdir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

// Create the workdir (and parents) before `git init -b main`, so each
// create-from-scratch helper is self-sufficient when the workdir does not yet
// exist.
export function ensureWorkdir(workdir: string): void {
  mkdirSync(workdir, { recursive: true });
}

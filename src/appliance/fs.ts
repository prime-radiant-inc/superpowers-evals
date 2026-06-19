import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function atomicWriteJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirPrivate(parent);
  const tmp = join(parent, `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
  try {
    return schema.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

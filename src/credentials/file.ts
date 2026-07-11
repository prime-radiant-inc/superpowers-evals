import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import {
  type Credential,
  parseCredentialsFile,
} from '../contracts/credential.ts';

export interface LoadedCredentials {
  readonly path: string;
  readonly credentials: Record<string, Credential>;
}

export interface LoadCredentialsFileOptions {
  // Only an OS-level ENOENT may become an empty registry. Permission, parse,
  // and schema failures are all configuration errors and must remain fatal.
  readonly allowMissing?: boolean;
}

function errorCode(err: unknown): string | undefined {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'string'
  ) {
    return err.code;
  }
  return undefined;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}

export function loadCredentialsFile(
  path: string,
  options: LoadCredentialsFileOptions = {},
): LoadedCredentials {
  const absolutePath = resolve(path);
  try {
    const raw: unknown = parseYaml(readFileSync(absolutePath, 'utf8'));
    return {
      path: absolutePath,
      credentials: parseCredentialsFile(raw),
    };
  } catch (err: unknown) {
    if (options.allowMissing && errorCode(err) === 'ENOENT') {
      return { path: absolutePath, credentials: {} };
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot load credentials file ${absolutePath}: ${reason}`);
  }
}

export function serializeCredentials(
  credentials: Record<string, Credential>,
): string {
  const parsed = parseCredentialsFile(credentials);
  return stringify(sortValue(parsed)).replace(/\n*$/, '\n');
}

export function writeCredentialsSnapshot(args: {
  readonly credentials: Record<string, Credential>;
  readonly destination: string;
}): string {
  const destination = resolve(args.destination);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, serializeCredentials(args.credentials), {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(destination, 0o600);
  return destination;
}

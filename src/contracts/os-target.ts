import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const RemoteConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).default(2222),
  user: z.string().default('user'),
  password_env: z.string().default('WIN_EVAL_PASSWORD'),
  win_run_root: z.string().default('C:\\eval-runs'),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const OsTargetSchema = z.object({
  name: z.string(),
  remote: RemoteConfigSchema.optional(),
});
export type OsTarget = z.infer<typeof OsTargetSchema>;

export class OsTargetError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'OsTargetError';
  }
}

export function loadOsTarget(osTargetsDir: string, name: string): OsTarget {
  if (name === 'linux') return { name: 'linux' };
  const path = join(osTargetsDir, `${name}.yaml`);
  if (!existsSync(path))
    throw new OsTargetError(`unknown os target '${name}': ${path} not found`);
  const parsed = OsTargetSchema.parse(parseYaml(readFileSync(path, 'utf8')));
  if (parsed.name !== name)
    throw new OsTargetError(
      `${path}: name must match file stem; got '${parsed.name}'`,
    );
  if (parsed.remote === undefined)
    throw new OsTargetError(
      `${path}: non-linux os target requires a remote block`,
    );
  return parsed;
}

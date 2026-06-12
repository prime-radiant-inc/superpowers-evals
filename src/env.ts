import { z } from 'zod';

// The ONLY module that reads process.env (coding standard §6.5). Everything else
// imports from here; the gate (Biome noProcessEnv) keeps it that way.

const EnvSchema = z.object({
  SUPERPOWERS_ROOT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

// The single sanctioned process.env read (§6.5); Biome exempts this file via override.
const source: Readonly<Record<string, string | undefined>> = process.env;

/** Parsed, frozen view of the known environment keys. */
export const env = Object.freeze(EnvSchema.parse(source));

/** Dynamic lookup for a scenario's `required_env` keys (§6.5). */
export function getEnv(key: string): string | undefined {
  return source[key];
}

/** Snapshot of the full environment, for composing subprocess env (§6.5). */
export function envSnapshot(): Readonly<Record<string, string | undefined>> {
  return source;
}

/** SUPERPOWERS_ROOT, required for live runs; throws if unset. */
export function superpowersRoot(): string {
  if (!env.SUPERPOWERS_ROOT) throw new Error('SUPERPOWERS_ROOT is not set');
  return env.SUPERPOWERS_ROOT;
}

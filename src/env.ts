// The ONLY module that reads process.env (coding standard §6.5). Everything else
// imports from here; the gate (Biome noProcessEnv) keeps it that way.

// The single sanctioned process.env read (§6.5); Biome exempts this file via override.
const source: Readonly<Record<string, string | undefined>> = process.env;

/** Dynamic lookup for a scenario's `required_env` keys (§6.5). */
export function getEnv(key: string): string | undefined {
  return source[key];
}

/** Snapshot of the full environment, for composing subprocess env (§6.5). */
export function envSnapshot(): Readonly<Record<string, string | undefined>> {
  return source;
}

/**
 * The single sanctioned process.env WRITE (§6.5). The drill-owned codex hook
 * install exports DRILL_CODEX_HOME; route that write through here rather than
 * touching process.env at the call site, keeping env.ts the only boundary.
 */
export function setProcessEnv(key: string, value: string): void {
  process.env[key] = value;
}

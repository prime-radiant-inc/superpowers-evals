import { readFileSync } from 'node:fs';
import { z } from 'zod';

// The dashboard's LOCAL read-type for grid-manifest.json. The on-disk JSON is
// the contract — the dashboard deliberately does NOT import the harness's
// grid-manifest contract (src/contracts/grid-manifest.ts), so the read side
// stays decoupled from the write side. This zod schema re-declares that on-disk
// shape and parses defensively: a missing/malformed manifest degrades to null
// rather than throwing, and the dashboard falls back to a results-only grid.

const GridManifestCellSchema = z.object({
  scenario: z.string(),
  agent: z.string(),
  // The credential name this cell runs under. Defaulted so a pre-credential
  // manifest still parses ('' = the agent's default / credential-less).
  credential: z.string().default(''),
  os: z.string(),
  eligible: z.boolean(),
  skipped_reason: z
    .enum(['directive', 'draft', 'tier', 'harness', 'os'])
    .nullable(),
});

const GridManifestSchema = z.object({
  generated_at: z.string(),
  scenarios: z.array(z.string()),
  agents: z.array(z.string()),
  cells: z.array(GridManifestCellSchema),
});

export type GridManifestCell = z.infer<typeof GridManifestCellSchema>;
export type GridManifest = z.infer<typeof GridManifestSchema>;

// Read + parse grid-manifest.json, or null on ANY error (missing file, bad
// JSON, schema mismatch). Never throws — the dashboard treats null as
// "no manifest" and renders a results-only grid.
export function loadGridManifest(path: string): GridManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = GridManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

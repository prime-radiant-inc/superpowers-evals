import { z } from 'zod';
import { REV_RECOVERY_STATUSES } from './rev-recovery.ts';

// One exported run. Identity fields mirror the verdict's self-identity block so
// the appliance never has to parse a run-dir name. `files` maps a bundle-
// relative path to its sha-256, which import verifies before anything lands.
export const BundleEntrySchema = z.object({
  run_id: z.string(),
  source_path: z.string(),
  scenario: z.string().nullable(),
  coding_agent: z.string().nullable(),
  credential: z.string().nullable(),
  os: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  final: z.string(),
  harness_rev: z.string().nullable(),
  rev_recovery: z.enum(REV_RECOVERY_STATUSES),
  superpowers_sha: z.string().nullable(),
  superpowers_tree_sha: z.string().nullable(),
  inferred_superpowers_sha: z.string().nullable(),
  files: z.record(z.string()),
});
export type BundleEntry = z.infer<typeof BundleEntrySchema>;

export const BundleSkipSchema = z.object({
  source_path: z.string(),
  reason: z.string(),
});
export type BundleSkip = z.infer<typeof BundleSkipSchema>;

export const BundleManifestSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.string(),
  source_host: z.string(),
  source_results_dir: z.string(),
  entries: z.array(BundleEntrySchema),
  skipped: z.array(BundleSkipSchema),
});
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

// Paths that must never appear in a bundle. The export allowlist should make
// these unreachable; import re-checks so the guarantee is verified at the
// boundary rather than trusted from whoever built the bundle.
export const CREDENTIAL_DENYLIST: readonly RegExp[] = [
  /(^|\/)auth\.json$/,
  /(^|\/)credentials\.snapshot\.yaml$/,
  /(^|\/)config\.toml$/,
  /(^|\/)\.env(\.|$)/,
  /\.pem$/,
  /\.key$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|ed25519)$/,
];

export function denylistHit(relPath: string): string | null {
  for (const pattern of CREDENTIAL_DENYLIST) {
    if (pattern.test(relPath)) {
      return pattern.source;
    }
  }
  return null;
}

#!/usr/bin/env bun
/**
 * Thin exported run dirs by deleting their throwaway $HOME.
 *
 * Usage:
 *   bun scripts/thin-run-homes.ts --results <dir> --bundle <bundle-dir> [options]
 *
 * Required:
 *   --results <dir>   local results tree (results/<label>/<run-id>/...)
 *   --bundle <dir>    the bundle built from it by `quorum export-runs`
 *
 * Options:
 *   --yes             actually delete; without it this is a dry run
 *   --skip-verify     skip re-hashing bundle payloads (faster, weaker guarantee)
 *   --json            machine-readable summary on stdout
 *   -h, --help        this text
 *
 * Why this exists:
 *   A finished run keeps the whole disposable $HOME the coding agent ran in —
 *   npm/bun caches, sqlite logs, archived plugin trees, and a live `auth.json`
 *   holding OAuth tokens. Across two corpora that was 54.9 GB of the 62 GB on
 *   disk. Once `quorum export-runs` has captured the analytical payload, the
 *   home is dead weight and a standing credential exposure.
 *
 * What it will not delete (each is reported, not silently skipped):
 *   - a run with no verdict.json — it crashed mid-flight, and its home is the
 *     only record of why
 *   - a run absent from the bundle manifest
 *   - a run whose bundle payload is missing or fails checksum verification
 *   - anything resolving outside --results, or not named exactly `home`
 *
 * Exit codes:
 *   0  clean (dry run, or deletion finished with nothing skipped unexpectedly)
 *   1  bad arguments or unusable inputs
 *   2  finished, but some runs were skipped — read the report
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { findRunDirs } from '../src/export-runs/index.ts';
import { BundleManifestSchema } from '../src/export-runs/manifest.ts';

interface Options {
  readonly results: string;
  readonly bundle: string;
  readonly yes: boolean;
  readonly skipVerify: boolean;
  readonly json: boolean;
}

interface Candidate {
  readonly runId: string;
  readonly homePath: string;
  readonly bytes: number;
}

interface Skip {
  readonly runId: string;
  readonly reason: string;
}

function usage(): never {
  const text = readFileSync(new URL(import.meta.url), 'utf8');
  const doc = text.slice(text.indexOf('/**'), text.indexOf('*/') + 2);
  process.stdout.write(`${doc}\n`);
  process.exit(0);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Options {
  let results: string | null = null;
  let bundle: string | null = null;
  let yes = false;
  let skipVerify = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
    } else if (arg === '--results') {
      results = argv[++i] ?? null;
    } else if (arg === '--bundle') {
      bundle = argv[++i] ?? null;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--skip-verify') {
      skipVerify = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (results === null || bundle === null) {
    fail('--results and --bundle are both required (--help for usage)');
  }
  const resolvedResults = resolve(results);
  const resolvedBundle = resolve(bundle);
  if (!existsSync(resolvedResults) || !statSync(resolvedResults).isDirectory()) {
    fail(`results dir does not exist: ${resolvedResults}`);
  }
  if (!existsSync(join(resolvedBundle, 'manifest.json'))) {
    fail(`bundle has no manifest.json: ${resolvedBundle}`);
  }

  return {
    results: resolvedResults,
    bundle: resolvedBundle,
    yes,
    skipVerify,
    json,
  };
}

function dirBytes(path: string): number {
  let total = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // A file that vanished mid-walk contributes nothing; keep going.
        }
      }
    }
  };
  visit(path);
  return total;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// The bundle is the only copy of the payload once a home is gone, so verify it
// still hashes to what the manifest recorded before trusting it.
function payloadIntact(
  bundleDir: string,
  runId: string,
  files: Record<string, string>,
): string | null {
  const runDir = join(bundleDir, 'runs', runId);
  if (!existsSync(runDir)) {
    return 'bundle payload dir is missing';
  }
  for (const [rel, expected] of Object.entries(files)) {
    const path = join(runDir, rel);
    if (!existsSync(path)) {
      return `bundle is missing ${rel}`;
    }
    if (Bun.SHA256.hash(readFileSync(path), 'hex') !== expected) {
      return `bundle checksum mismatch for ${rel}`;
    }
  }
  return null;
}

// A home qualifies only if the run it belongs to is provably captured. The
// path checks are belt-and-braces against a manifest naming something odd.
function classify(
  options: Options,
  runDir: string,
  manifestFiles: Map<string, Record<string, string>>,
): { candidate: Candidate } | { skip: Skip } {
  const runId = basename(runDir);
  const homePath = join(runDir, 'home');

  if (!existsSync(homePath) || !statSync(homePath).isDirectory()) {
    return { skip: { runId, reason: 'no home/ dir' } };
  }
  if (basename(homePath) !== 'home') {
    return { skip: { runId, reason: 'refusing: path is not named home' } };
  }
  const rel = relative(options.results, homePath);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    return { skip: { runId, reason: 'refusing: path escapes --results' } };
  }
  if (!existsSync(join(runDir, 'verdict.json'))) {
    return {
      skip: { runId, reason: 'no verdict.json (crashed run — home is its only record)' },
    };
  }
  const files = manifestFiles.get(runId);
  if (files === undefined) {
    return { skip: { runId, reason: 'not present in the bundle manifest' } };
  }
  if (!options.skipVerify) {
    const problem = payloadIntact(options.bundle, runId, files);
    if (problem !== null) {
      return { skip: { runId, reason: problem } };
    }
  }
  return { candidate: { runId, homePath, bytes: dirBytes(homePath) } };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const manifest = BundleManifestSchema.parse(
    JSON.parse(readFileSync(join(options.bundle, 'manifest.json'), 'utf8')),
  );
  const manifestFiles = new Map(
    manifest.entries.map((entry) => [entry.run_id, entry.files]),
  );

  const candidates: Candidate[] = [];
  const skips: Skip[] = [];
  for (const runDir of findRunDirs(options.results)) {
    const verdict = classify(options, runDir, manifestFiles);
    if ('candidate' in verdict) {
      candidates.push(verdict.candidate);
    } else if (verdict.skip.reason !== 'no home/ dir') {
      // "no home" is the steady state after a previous pass; not worth reporting.
      skips.push(verdict.skip);
    }
  }

  const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
  let freed = 0;
  const failures: Skip[] = [];

  if (options.yes) {
    for (const candidate of candidates) {
      try {
        rmSync(candidate.homePath, { recursive: true, force: true });
        freed += candidate.bytes;
      } catch (error) {
        failures.push({
          runId: candidate.runId,
          reason: `delete failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dry_run: !options.yes,
          results_dir: options.results,
          bundle_dir: options.bundle,
          verified_checksums: !options.skipVerify,
          candidates: candidates.length,
          bytes: total,
          freed_bytes: freed,
          skipped: [...skips, ...failures],
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const mode = options.yes ? 'DELETED' : 'would delete';
    process.stdout.write(
      `${mode} ${candidates.length} run home(s), ${gb(options.yes ? freed : total)}\n` +
        `  results: ${options.results}\n` +
        `  bundle:  ${options.bundle}${options.skipVerify ? ' (checksums NOT verified)' : ' (checksums verified)'}\n`,
    );
    if (skips.length > 0) {
      process.stdout.write(`\nkept ${skips.length} home(s):\n`);
      for (const skip of skips.slice(0, 20)) {
        process.stdout.write(`  ${skip.runId}\n    ${skip.reason}\n`);
      }
      if (skips.length > 20) {
        process.stdout.write(`  ... and ${skips.length - 20} more\n`);
      }
    }
    for (const failure of failures) {
      process.stderr.write(`FAILED ${failure.runId}: ${failure.reason}\n`);
    }
    if (!options.yes) {
      process.stdout.write('\ndry run — re-run with --yes to delete\n');
    }
  }

  process.exit(skips.length > 0 || failures.length > 0 ? 2 : 0);
}

main();

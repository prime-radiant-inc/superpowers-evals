import { join, resolve } from 'node:path';
import { loadGridManifest } from './manifest.ts';
import { createDashboard } from './server.ts';

// The dashboard entry point. Binds createDashboard's fetch handler to a
// Bun.serve instance and starts the scanner loop. The read-only web dashboard
// and the e2e tests both go through here.
//
// The dashboard's only inputs are the filesystem: results/ and the grid manifest
// at `manifestPath`. It imports nothing from the harness.

export interface StartDashboardArgs {
  readonly port: number;
  readonly resultsRoot: string;
  readonly manifestPath: string;
}

export interface DashboardHandle {
  readonly port: number;
  stop(): void;
}

export interface DashboardCliArgs {
  readonly resultsDir: string;
  readonly port: number;
  readonly manifestPath: string;
  readonly root: string;
}

// Parse argv (the part AFTER the script name). Flags: --results <dir> (default
// 'results'), --port <n> (default 8787), --root <repo> (default process.cwd()),
// --manifest <path> (default <root>/grid-manifest.json). Unknown flags are
// ignored. `cwd` is injectable for testability (defaults to process.cwd()).
export function parseArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): DashboardCliArgs {
  let resultsDir = 'results';
  let port = 8787;
  let root = cwd;
  let manifest: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') {
      resultsDir = argv[++i] ?? resultsDir;
    } else if (a === '--port') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) port = n;
    } else if (a === '--root') {
      root = argv[++i] ?? root;
    } else if (a === '--manifest') {
      manifest = argv[++i];
    }
  }
  const manifestPath = manifest ?? join(root, 'grid-manifest.json');
  return { resultsDir, port, manifestPath, root };
}

export function startDashboard(args: StartDashboardArgs): DashboardHandle {
  // The grid manifest is the scenario × agent × os eligibility matrix; null when
  // absent/malformed (a results-only board). Its `agents` are the read-side
  // longest-suffix list a run dir's agent segment resolves against.
  const manifest = loadGridManifest(args.manifestPath);
  const knownAgents = manifest?.agents ?? [];
  const dash = createDashboard({
    resultsRoot: args.resultsRoot,
    knownAgents,
    manifest,
  });
  // idleTimeout: 0 disables Bun.serve's per-request idle timeout (default 10s).
  // The GET /events SSE stream is intentionally long-lived; with the default a
  // quiet connection is killed every 10s ("request timed out after 10 seconds"
  // on the console) and htmx reconnect-loops. The stream's own keepalive keeps
  // proxies/clients warm.
  const server = Bun.serve({
    port: args.port,
    idleTimeout: 0,
    fetch: dash.fetch,
  });
  dash.startScanner();
  // server.port is the actually-bound port (the ephemeral pick when port 0 was
  // requested). Bun types it as possibly-undefined; fall back to the requested
  // port, which is concrete for any non-zero launch.
  const boundPort = server.port ?? args.port;
  return {
    port: boundPort,
    stop: () => {
      dash.stopScanner();
      server.stop(true);
    },
  };
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const handle = startDashboard({
    port: cli.port,
    // Resolve resultsDir against root (not cwd) so --root /repo always reads
    // results from /repo/results, whether or not --results was also given.
    resultsRoot: resolve(cli.root, cli.resultsDir),
    manifestPath: resolve(cli.manifestPath),
  });
  // Print the bound URL so the user knows where to point a browser.
  process.stdout.write(`dashboard: http://localhost:${handle.port}/\n`);
}

if (import.meta.main) {
  main();
}

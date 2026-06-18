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

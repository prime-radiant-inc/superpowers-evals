import type { InvokeFn } from '../run-all/index.ts';
import { knownAgentNames } from '../run-all/matrix.ts';
import { createDashboard } from './server.ts';

// The dashboard entry point (PRI-2207, Spec 5, Task 14). Binds createDashboard's
// fetch handler to a Bun.serve instance and starts the scanner loop. The CLI
// `dashboard` command (src/cli/index.ts) and the e2e tests both go through here.

export interface StartDashboardArgs {
  readonly port: number;
  readonly resultsRoot: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly jobs: number;
  // Injectable child launcher — tests stub it so no real `quorum run` spawns. The
  // server's orchestrator uses the live invokeChild by default.
  readonly invoke?: InvokeFn;
}

export interface DashboardHandle {
  readonly port: number;
  stop(): void;
}

export function startDashboard(args: StartDashboardArgs): DashboardHandle {
  // knownAgents is the read-side longest-suffix list (the same *.yaml stems
  // buildMatrix derives `available` from), so a run dir's agent segment resolves
  // identically whether run-all or the dashboard launched it.
  const knownAgents = knownAgentNames(args.codingAgentsDir);
  const dash = createDashboard({
    resultsRoot: args.resultsRoot,
    scenariosRoot: args.scenariosRoot,
    codingAgentsDir: args.codingAgentsDir,
    jobs: args.jobs,
    knownAgents,
    ...(args.invoke !== undefined ? { invoke: args.invoke } : {}),
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

// The child-spawner seam (Decision D-8): the dispatcher observes fake
// children with scripted protocol lines, exit codes, and run-dirs in tests;
// production wraps detached process-group-leader spawn (task 6). Journal FDs
// never reach children (stdio pinning — the Linux matrix asserts it).

export interface CampaignChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Inside the snapshot (R-SPN-8). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ChildExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedCampaignChild {
  /** The dispatcher validates pgid == pid before journaling run_allocated
   *  (R-SPN-2); the production spawner guarantees detached setsid. */
  readonly pid: number;
  /** Buffered protocol surface: everything observed so far. */
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  /** Subscription for lines arriving after spawn (the parent-pinned
   *  `run_allocated: <run_id>` line; stderr feeds the sensors). */
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  onExit(cb: (info: ChildExitInfo) => void): void;
}

export interface ChildSpawner {
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild;
}

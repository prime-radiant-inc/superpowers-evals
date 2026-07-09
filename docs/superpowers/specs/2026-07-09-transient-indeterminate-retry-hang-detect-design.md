# Transient-indeterminate retry + startup hang-detect — design

**Status:** design approved 2026-07-09 (Drew); revised the same day after an
adversarial review (workflow `wf_e0471d0b-2f6`, verdict *needs-rework* → 25/27
findings folded in); verification pass `wf_9fef25b6-c55` confirmed 25/25
resolutions against code and returned *ready-with-edits* → 6 edits applied;
implementation not started.
**Motivated by:** the CC-on-Bedrock sentinel (2026-07-09), which surfaced a
~11% indeterminate rate from transient AWS-side Mantle capacity blips (see
[[pri-2517-bedrock-review]]).
**Related:** rule 7 (indeterminate handling); `AgyRateLimitWatcher` /
`ANTIGRAVITY_RATE_LIMIT_MARKER` / `killGauntletTmuxForRun` (the existing
detect→marker→teardown precedent this mirrors); the run-all rate-limit latch
(owns antigravity backoff — must not be fought); PRI-2494 (launcher isolation).
**Ticket:** TBD (file before implementation).

## Motivation

A proving run must produce a **pass or fail for every cell**. Manual triage of
flaky cells does not scale to a multi-harness panel and erodes trust in the grid.

The CC-on-Bedrock sentinel produced 4/36 indeterminates, all traced to a single
external cause: a transient ~30-minute window where Mantle/Bedrock **on-demand**
Opus capacity was momentarily saturated (`model is overloaded or unavailable`).
Our access, entitlement, and quota were all fine (opus-4-8 + opus-4-7 both HTTP
200 on Mantle, AUTHORIZED, ~1000× quota headroom); rep 1 was clean. **Claude Code
handles the transient error badly — it busy-loops/hangs instead of erroring or
retrying** — converting a few seconds of AWS overload into a dead run that also
burns the grader's full time budget.

Provisioned Throughput (dedicated capacity) would eliminate the blips but is not
affordable now. So we make the harness **survive** transient upstream faults:
detect a wedged agent fast and abort, and retry the transient-infra
indeterminates that result.

The two symptom shapes, and which mechanism owns each:

| symptom | how it composes | owned by |
|---|---|---|
| Claude wedges at/just-after launch (overload on the generation call) → transcript is absent or **user-turn-only, no assistant turn** | watcher tears down → indeterminate `stage=capture` carrying the **hang marker** | hang-detect (fast abort) → retry |
| Claude limps mid-run → grader self-grades at `--max-time` | `gauntlet.status = investigate` when the report is unsubstantiated/absent AND capture produced ≥1 tool-call row (a zero-tool-row limp is intercepted by the strict capture cascade before compose and is terminal — Decision 3's residual; **the grader may instead self-grade `fail`, which is terminal and never retried**) | retry (post-hoc) |

## Locked decisions

1. **Retry cap: 2 retries (3 attempts total),** configurable. Transient blips
   almost always clear on the first retry.
2. **Retryable = a positively-marked transient class, never a stage/reason
   catch-all.** Retry iff the composed verdict is `indeterminate` AND either:
   - its `error.message` carries the **`CLAUDE_STARTUP_HANG_MARKER`** (a watcher
     stamp, mirroring `ANTIGRAVITY_RATE_LIMIT_MARKER`), OR
   - `gauntlet.status ∈ {investigate, errored}` **AND `error == null`** (a
     composer-produced grader non-completion; the `error == null` gate excludes
     the antigravity rate-limit teardown, which carries `error.stage = 'gauntlet'`
     and whose backoff the run-all latch already owns).

   `errored` is retained for defensive parity with `composer.ts:75` but is
   **unreachable from real runs** (`coerceGauntletStatus` maps `errored →
   investigate` at `runner/index.ts:170`).
3. **Never retry (terminal):** `pass`, `fail`, any `error.stage ∈ {setup,
   gauntlet}`, failed pre-checks, agent-skip / missing-`checks.sh`, and every
   **unmarked** capture-empty verdict (`stage=capture` **without** the hang
   marker — e.g. pi zero-rows `index.ts:500-506`, unusable headers `480-494`,
   copilot secret-leak, claude's own no-transcript/zero-rows branch
   `index.ts:528-546`, gemini/opencode/kimi zero-row backends). **Accepted
   residual:** a watcher-missed transient hang (watcher bug, budget outlived, or
   a wedge after the first assistant turn but before any tool call — where
   Decision 4 stands the watcher down) lands here unmarked and is terminal by
   design; it falls back to manual triage. The old
   `v.gauntlet == null` clause is **deleted**: in this runner every terminal
   indeterminate carries `gauntlet:null` (setup/pre-check compose sites
   `index.ts:861,1218,1229`), and its intended "gauntlet ran, produced nothing"
   target is dead code — `invokeGauntlet` always returns
   `gauntletLayerFromRunDir(runDir) ?? {status:'investigate'}` (`index.ts:341`).
4. **Startup hang-detect keys on transcript LIVENESS, not file existence.**
   Claude writes the `.jsonl` (session header + user turn) at session start and
   streams the assistant turn later; the overload hang lands on the generation
   call, *after* the file exists (verified against a real transcript: user turn
   ~4s before the first assistant turn). So the watcher is **two-phase**:
   - **(a) await launch** — launch = the per-attempt **`$QUORUM_LAUNCH_MARKER`**
     file appearing (touched by the claude launcher immediately before its
     `exec env -i … claude` line; path substituted as a literal at provision
     time — tmux strips env, per the launcher's own header; one marker per
     attempt under `attempts/<n>/` so retries re-arm this phase). No teardown
     budget here; a grader that never launches Claude is bounded by the grader's
     own `--max-time`.
   - **(b) liveness budget** — starts only after launch; liveness = a first
     `assistant`-role entry in the newest transcript within the budget. Growth
     alone is NOT liveness: non-model writes (attachments, file-history-snapshot,
     ai-title, nudge user turns) grow the file without a model response, and
     growth must never extend the budget — a wedged run's nudges would extend it
     indefinitely. On expiry with no assistant-role entry (file absent,
     user-turn-only, or grown only via non-assistant entries) → tear down the
     gauntlet tmux and stamp `CLAUDE_STARTUP_HANG_MARKER`. Budget is
     per-agent-config overridable; calibrated against real *launch→first-assistant*
     latency (see Open items).
5. **Retry granularity: whole cell, clean re-setup per attempt, ONE canonical run
   dir.** The cell's run dir is the `run_id` (what `allocateRunDir` mints,
   `onRunDir` fires exactly once with, the CLI prints, the dashboard buckets,
   run-all reads). Per-attempt evidence lives in nested
   **`<runDir>/attempts/<n>/`** (own workdir, throwaway home,
   `gauntlet-agent/results`, trajectory, per-attempt verdict). **`phase.json` is
   cell-root state, not per-attempt evidence:** `driveOnce` writes its
   setup/agent/checks transitions via `writePhase` against the CELL run dir on
   every attempt (same file, updated in place — a retry visibly cycles back to
   `setup`), because the dashboard resolves in-flight placement and pid-liveness
   exclusively from `<runDir>/phase.json` and the scanner never recurses
   `attempts/` (§4). The retry loop
   lives *inside* `runScenario`, wrapping only the inner drive; dir allocation,
   `onRunDir`, and identity stamping stay outside the loop and fire once. A
   mid-retry Ctrl-C writes one stopped verdict to the cell dir.
6. **Visibility, not laundering.** The cell verdict records every attempt
   (`attempts: [{final, final_reason, est_cost_usd}]` + `attempt_count`), and the
   cell's `economics` **sums across attempts**. Any `final=pass` reached only
   after an investigate/hang attempt is flagged **flaked-green** in `show`, the
   dashboard, and run-all, so a human can still apply rule 7 in aggregate.
   **Accepted limitation (Drew, 2026-07-09):** the harness cannot behaviorally
   separate a transient hang from an agent-failure-to-engage that grades
   `investigate` (both carry `investigate` + `run_id`; the composer encodes no
   split). Retry *will* re-run such a run and it may flake green — the flaked-green
   flag preserves auditability; a true split (richer `investigate` provenance from
   the grader) is a filed follow-up, not in scope.

## Non-goals

- **Not** Provisioned Throughput (cost).
- **Not** fixing Claude Code's hang-on-transient-error behavior (upstream).
- **Not** a mid-run hang detector beyond the grader's own `--max-time`.
- **Not** a behavioral split of `investigate` into transient-vs-agent-failure —
  see Decision 6's accepted limitation. (The prior spec's claim that "rule 7
  already counts agent-failure-to-engage as a fail" is **false at the harness
  layer** and is struck.)
- **Not** remote-runtime (windows) hang detection — the guest transcript is
  invisible to the host until `captureBack` after gauntlet exits; remote runs
  stay bounded by the grader's `--max-time`.
- **Not** changing `--max-time` or the shallow `captureToolCallsWithRetry`
  read-retry (kept as-is; it beats a slow-to-flush transcript, a different race).

## Architecture

Both mechanisms live in the **runner** (`src/runner/index.ts`); the retry loop is
inside `runScenario` so every caller (local `quorum run`, `run-all`, appliance)
inherits it, while the single-run-dir contract (§5) is preserved.

### 1. Retryable-class predicate (`src/runner/retry.ts`, new)

Pure over the composed `FinalVerdict`:

```ts
export function isRetryableIndeterminate(v: FinalVerdict): boolean
```

`true` iff `v.final === 'indeterminate'` AND
(`v.error?.message?.includes(CLAUDE_STARTUP_HANG_MARKER)` OR
(`(v.gauntlet?.status === 'investigate' || v.gauntlet?.status === 'errored')` AND
`v.error == null`)). `false` for everything in Decision 3. Pure + table-driven →
unit-tested against every composer branch, including the four `gauntlet:null`
terminals (must return `false`).

### 2. Retry loop (inside `runScenario`)

Cap threads through a new optional `RunScenarioArgs.maxRetries` (default 2); there
is **no** `RunContext` seam (that was fabricated — removed). `run-all` overrides
via a new `--max-retries` flag emitted in `buildChildRunArgs`.

```ts
const maxRetries = a.maxRetries ?? 2;
const attempts = [];
let v;
for (let n = 1; n <= maxRetries + 1; n++) {
  v = await driveOnce(/* into <runDir>/attempts/<n>/ */);
  attempts.push({ final: v.final, final_reason: v.final_reason,
                  est_cost_usd: attemptCost(v) });
  if (n > maxRetries || !isRetryableIndeterminate(v)) break;
}
return withAttempts(v, attempts); // last attempt's verdict + summed economics
```

`driveOnce` is the extracted inner drive (setup → gauntlet → capture → compose)
targeting the per-attempt subdir; extraction detail → plan. The cell verdict is
the last attempt's, annotated with `attempts`/`attempt_count`, `economics` summed,
and the flaked-green flag set if any non-final attempt was investigate/hang.

### 3. Startup-liveness watcher (`src/agents/startup-watch.ts`, new)

Mirrors `AgyRateLimitWatcher`; the two are **per-family alternatives gated by
`cfg.normalizer`** (claude ↔ startup watcher; antigravity ↔ rate-limit watcher),
**never concurrent** — so this replaces, not augments, the agy-watcher `.start()`
site. The startup watcher additionally requires the **local runtime**
(`os === 'linux'`, mirroring the `preflightCodingAgentBinary` seam,
`index.ts:963-967`): on `--os windows` the guest transcript reaches the local
`logDir` only via `captureBack` after gauntlet exits, so an armed watcher would
poll an empty dir and falsely tear down 100% of claude-windows cells, then burn
the retry cap.

- Reuses the runner's already-resolved `logDir`
  (`resolveSessionLogDir(cfg.session_log_dir)`, `index.ts:1258`) + `cfg.session_log_glob`
  (`**/*.jsonl`, recursive) and the same `snapshotDir`/`newFilesSince` machinery
  capture uses — **no** hand-computed `projects/<slug>/` path (the harness never
  computes a slug; that would poll a nonexistent dir and tear down 100% of runs).
  Watcher inputs are exactly: the per-attempt `$QUORUM_LAUNCH_MARKER` file
  (phase (a)'s launch signal) + the `logDir`/glob snapshots (phase (b)'s
  liveness signal).
- Two-phase per Decision 4: await a launch signal, then run the liveness budget.
- On liveness failure → `teardown` wired to `killGauntletTmuxForRun` (proven to
  work for claude: `buildGauntletArgv` hardcodes `--adapter tui` for every agent,
  so `killRunTmuxServer`'s scratch-dir match is agent-agnostic) and stamp
  `CLAUDE_STARTUP_HANG_MARKER` into the resulting `stage=capture` indeterminate
  (same `writeIndeterminate` path the agy marker uses, `index.ts:1446-1458`).

### 4. Surfacing (visibility, not laundering)

- **`contracts/verdict.ts`**: add `attempts: {final, final_reason,
  est_cost_usd: number|null}[]` (null when a hang-torn-down attempt has no
  priced trajectory), `attempt_count`, and `flaked_green: boolean` to
  `FinalVerdict` (zod + type) — **all three `.optional()`**, per the file's own
  back-compat precedent (`verdict.ts:61-79`), so every pre-retry `verdict.json`
  still parses. The runner always writes all three on new verdicts
  (single-attempt: `attempt_count: 1`, `flaked_green: false`); readers treat
  absence as single-attempt/false.
- **`cli/render.ts` `formatHeader`**: an `attempts N (flaked-green)` line when
  `attempt_count > 1`.
- **dashboard**: extend `DashboardVerdictSchema` + `cellHtml` with a retry/
  flaked-green badge (scanner stays shallow — nested `attempts/` never recursed;
  live `phase.json` therefore stays at the cell dir).
- **run-all**: extend `VerdictViewSchema`, add a `retries` tally + footer line;
  `batchCostTotal` auto-corrects once cell `economics.coding_agent.est_cost_usd`
  is the across-attempts sum (keep the deliberate grader-exclusion in the batch
  total).

## Interaction / edge cases

- **Economics aggregation (M5):** a 3-attempt cell must report summed
  `coding_agent` + `gauntlet` cost, not 1×; each `attempts` entry carries its own
  cost. Otherwise retried spend is invisible and the batch total under-reports.
- **Idempotent re-setup:** each attempt builds a fresh workdir + throwaway home in
  its own `attempts/<n>/`; no state leaks between attempts.
- **Cost bound:** worst case (cap+1)× a normal run per cell; the cap bounds it and
  run-all's retry tally makes a systemic flake spike visible.
- **False teardown:** a legitimately slow first assistant turn torn down at the
  budget just re-runs (time cost, not correctness); budget is conservative +
  tunable, and phase (a) prevents counting grader boot as a hang.
- **No fail-laundering of a real `fail`:** only `indeterminate` is retried, so a
  self-graded `fail` never becomes a pass. The residual laundering vector is the
  investigate/agent-failure-to-engage case (Decision 6), mitigated by the flag.
- **Accepted residual (unmarked hangs):** a transient hang the watcher misses
  (watcher bug, budget outlived, or a wedge after the first assistant turn but
  before any tool call) composes as unmarked `stage=capture` and is terminal by
  design (Decision 3) — visible for manual triage, never silently retried.

## Tests / DoD

Unit (hermetic, Tier-1):
- `isRetryableIndeterminate`: hang-marker capture → true; investigate + `error==null`
  → true; investigate + `error.stage='gauntlet'` (agy latch) → **false**;
  setup-stage error → false; each of the four `gauntlet:null` terminals
  (setup throw, missing `checks.sh`, agent-skip, pre-check crash/fail) → **false**;
  deterministic `stage=capture` without marker → false; pass → false; fail → false.
- Retry loop (fake `driveOnce`): retries a marked/investigate indeterminate to the
  cap then surfaces it; stops on pass/fail/terminal-indeterminate; one `attempts`
  entry per attempt; economics summed; flaked_green set iff a prior attempt was
  investigate/hang; `onRunDir` fires exactly once; a mid-retry stop writes one
  stopped verdict; `phase.json` written at the cell root, never under
  `attempts/<n>/`, on every attempt.
- `StartupLivenessWatcher` (fake clock + fake fs): launch derived from the
  `$QUORUM_LAUNCH_MARKER` file appearing (not an injected launch event), so the
  absent-file case exercises real wiring — marker present + no `.jsonl` at
  expiry → teardown + `CLAUDE_STARTUP_HANG_MARKER`; also fires on
  user-turn-only-stalled AND despite post-user-turn growth from
  attachment/ai-title/file-history-snapshot/nudge entries; never fires when an
  assistant-role entry appears first; never armed when `os !== 'linux'` even
  with normalizer `claude`; stands down cleanly; keys on `logDir`+glob (no slug).
- `errored`: assert `coerceGauntletStatus` maps a gauntlet `result.json`
  `status:'errored'` → `investigate` and it retries via the investigate disjunct
  (extends `test/runner-gauntlet-result.test.ts`).
- Surfacing: schema round-trips `attempts`/`attempt_count`/`flaked_green`
  (including `est_cost_usd: null` entries); a pre-retry verdict lacking all
  three fields still parses everywhere (`quorum show` exits 0; appliance
  hasTerminalArtifact/runArtifactStopped unaffected — no `lost` degradation);
  `show` renders the attempts line; dashboard/run-all schemas accept + display
  them.

Live DoD (trusted-maintainer): re-run the 12-scenario CC sentinel × opus_bedrock
× n=3. Bar: **no transient-retryable indeterminate resolves within the cap
unseen** — every remaining indeterminate is a chronic flake, visible as
`attempt_count == cap+1` with every attempt in a retryable class; any flaked-green
cell is flagged. Hang-detect + "retry resolves it" is exercised by a **transient
fault injected on attempt 1 only** (a hook that suppresses just the first
attempt's assistant-turn write), NOT a statically-unentitled model (which is
permanent and can never resolve on retry).

## Open items

- **Liveness budget:** the launch signal is PINNED (Decision 4a: the per-attempt
  `$QUORUM_LAUNCH_MARKER` touched by the launcher; a first-transcript-appearance
  proxy is REJECTED — it cannot implement the absent-file teardown, silently
  reclassifying the empirically-real launched-but-transcriptless hang as
  terminal). Remaining open: calibrate the phase-(b) budget against real
  launch→first-assistant latency under load (should be « the grader
  `--max-time`); starting value 90–120s, tune. → plan/live.
- **Version-contingent transcript signal:** the assistant-turn liveness signal
  depends on claude's session-persistence behavior (`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`,
  already set); re-verify on each claude CLI bump.
- **`driveOnce` extraction** boundary + attempt-subdir plumbing → plan.
- **True `investigate` split** (grader emits transient-vs-agent-failure cause) →
  filed follow-up, out of scope.
- **File the ticket** and cross-link before implementation.

## References

- Reviews: workflow `wf_e0471d0b-2f6` (27 raised / 25 verified / verdict
  needs-rework) + verification pass `wf_9fef25b6-c55` (25/25 resolutions
  confirmed against code; 11 findings → 6 edits, applied; verdict
  ready-with-edits); CC-sentinel diagnosis in `[[pri-2517-bedrock-review]]`.
- Code precedents: `src/agents/agy-watch.ts`, `ANTIGRAVITY_RATE_LIMIT_MARKER` +
  `writeIndeterminate` (`src/runner/index.ts:1446-1458`), `killGauntletTmuxForRun`
  (`:232`), `coerceGauntletStatus` (`:170`), `resolveSessionLogDir` (`:1258`),
  `src/composer.ts`, `src/contracts/verdict.ts`, dashboard `scan.ts`, run-all
  cost tally.

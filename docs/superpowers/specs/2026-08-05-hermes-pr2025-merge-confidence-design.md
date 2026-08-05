# Hermes PR #2025 merge-confidence campaign — design

Date: 2026-08-05 (v2 — revised after three-lens staff review; v1's normalizer
remedy was empirically disproven and its rebuild procedure was a cache no-op)
Status: approved (maintainer session, 2026-08-05; v2 decisions delegated)

## Problem

obra/superpowers PR #2025 (`hermes-harness-rebase`) is the landing vehicle for
Hermes Agent support: a `.hermes-plugin/` that injects the `using-superpowers`
bootstrap via `pre_llm_call` first-turn context and registers the stock skills
tree natively (`ctx.register_skill`). Its only eval evidence is our n=1
`superpowers-bootstrap` GREEN from the 2026-07-23 bring-up, run on hermes
v0.19.0. We want a merge-confidence verdict stronger than n=1, produced by the
existing hermes quorum target, plus fixes for the harness gaps that would
taint that verdict — and a written recipe so testing a superpowers PR against
hermes is routine.

Structural hermes facts that shape everything: injected bootstrap context is
never visible in session exports (persisted `api_content` sidecar), so all
injection proof is behavioral; hermes has no post-compaction hook, so the
bootstrap is lost permanently on compaction (documented in the PR — not
re-litigated here); hermes carries token/cost data at session level only
(per-message `token_count` is always null).

## Decisions (maintainer-confirmed)

1. **Scope is merge-confidence, not full citizenship.** A scoped battery keyed
   to the PR's claims, against a pinned PR-2025 head. Full-grid signature
   waits for `dev`.
2. **Battery runs on the newest hermes CLI, pinned by commit.** The Dockerfile
   hermes layer gains `ARG HERMES_COMMIT` passed to the NousResearch
   installer's `--commit` flag (a bare rebuild is a BuildKit cache no-op —
   the v1 procedure validated nothing). Before rebuilding, retag the current
   image `superpowers-evals:pre-hermes20-v0190` so the v0.19.0 fallback stays
   addressable. If v0.20.x breaks harness plumbing at smoke, fall back to
   that tag, pin v0.19.0, and file the drift separately.
3. **Trust fixes land before any battery run**, `bun run check` green:
   normalizer pricing (§C1), tool-name map (§C2), CLI pin + probe timeout
   (§C3).
4. **Hermes' embedded `estimated_cost_usd` is honored** (→
   `final_metrics.total_cost_usd`). Refusing it while honoring pi/opencode's
   identical-in-kind embedded estimates was policy inconsistency; honoring it
   gives parity with hermes' own accounting and immunity to obol table drift.
5. **Credential: `openrouter_glm_5_2`.** Hermes-4-family evidence stays
   blocked (OpenRouter hermes-4 exposes no `tools` param) — out of scope.
6. **Pre-registered decision rules** (§Battery) are written into the
   experiment doc before run 1. No post-hoc adjudication of reds.
7. **Posting results to the PR is a separate, explicit maintainer step.**

## Components

### C1. Normalizer pricing fix (`src/normalize/hermes.ts`)

The July $0.00 has two causes, both verified by probe: the trajectory carries
no model id, and obol's `z-ai/glm-5.2` rate is **provider-gated** — model
stamping alone yields `UnpricedModel` (cost null), not a price. The v1 "mirror
pi" remedy was wrong (pi prices via per-step embedded costs hermes cannot
have); the correct precedent is **copilot** (`src/normalize/copilot.ts:322`).

Fix, TDD'd against `test/fixtures/hermes-real-session.jsonl`:

- stamp `agent.model_name` from the session's top-level `model`;
- stamp `final_metrics.extra.provider` from the session's `billing_provider`
  verbatim (absent → skip → honest `UnpricedModel`);
- honor `estimated_cost_usd` → `final_metrics.total_cost_usd` (decision 4);
- fix the stale `extra.cache_write` comment while in the file.

Tests assert structurally (nonzero estimate, `unpriced_models` empty, no
`UnknownModelForTurn`), never exact dollars — rates differ across obol
0.8.0/0.9.0 and the local `node_modules` currently disagrees with `bun.lock`;
run `bun install` before `bun run check`. Costs are frozen at capture; July
runs stay unpriced. Expected.

### C2. Tool-name map fix (`HERMES_TOOL_MAP`, `src/normalize/hermes.ts:52`)

The map holds Harbor-era guesses; only `terminal` and `skill_view` are
live-verified, and the PR's own `hermes-tools.md` names `delegate_task`
(subagents) and `patch` (edits) — neither mapped. Consequences as-is: two
battery cells false-fail on `tool-called Agent`, and every
`skill-before-tool … Edit` check in the battery — including the headline
bootstrap scenario — passes vacuously.

Fix: an in-container toolset probe (one `--yolo` session that dispatches a
subagent and edits a file, then `sessions export`) establishes ground truth;
then add `delegate_task → Agent`, `patch → Edit`, `web_extract → WebFetch`,
`todo → TodoWrite`, TDD'd against the probe's export. If the probe shows
hermes v0.20 has no subagent tool, the Agent-requiring cell drops from the
battery instead of buying an unattributable red. The probe also answers
whether subagent dispatch mints child sessions in `state.db` — if yes,
`mergeTrajectories`' envelope-only `final_metrics` under-counts multi-session
costs: fix the merge then, else skip (no speculative fix).

### C3. CLI pin + resolve-test gap

- `pin_cli_version` in `hermes.yaml`, full `vX.Y.Z` string, committed
  **before** the smoke (the smoke should be pin-guarded too).
- `probeCliVersionLine` (`src/contracts/agent-config.ts`) gains a spawnSync
  timeout (~30s): hermes' `--version` performs a synchronous network update
  check and can wedge in an egress-restricted container.
- `test/agents-resolve.test.ts` gains the missing hermes dispatch case.

### C4. The recipe (`docs/coding-agent-care-and-feeding.md`, hermes section)

"Testing a superpowers PR" subsection, with the order mandatory because
`QUORUM_SUPERPOWERS_REV` freezes at container-create and the env override
beats the in-container probe:

1. Dedicated clone (not a linked worktree — its in-container git probe dies)
   of superpowers at the **detached, recorded PR-head SHA**;
2. `evals-container down && up` with `--superpowers-root` at that clone;
3. in-container `hermes version` probe → `pin_cli_version` committed;
4. smoke, then battery; verify run 1's `provenance.superpowers_rev` equals
   the recorded SHA before counting anything.

Identify the subject only as `pull/2025/head @ <sha>` (the PR's `plugin.yaml`
says 6.1.1 while the repo is at 6.2.x — version strings would misdate the
evidence). During the smoke, probe whether `hermes plugins install` accepts a
branch/ref: if yes, one real-install bootstrap run replaces the staged-copy
deferral; if no, record the probe output and the post-merge deferral stands.

### C5. The battery

All in-container, `--coding-agent hermes`, default credential, against the
pinned PR head. `global-tool-mapping-comprehension` is dropped for hermes:
its AC demands transcript evidence of reading the mapping file, but the
plugin embeds the mapping in the (export-invisible) bootstrap — the scenario
punishes the PR's design.

| Runs | Cell | PR claim under test |
|---|---|---|
| 3 | `superpowers-bootstrap`, spread first/middle/last | bootstrap lands + gates fire (smoke counts as run 1 iff capture is intact, regardless of verdict) |
| 7 | `triggering-*` (all seven), n=1 screen | bootstrap causes skill invocation across skill types |
| 1 | **new** two-turn persistence probe | `api_content` replay: turn 1 innocuous, turn 2 the naive trigger, no skill names anywhere — the only run shape that observes persistence behaviorally |
| 1 | neutered-plugin RED arm (`pre_llm_call` → None on a staged copy) | the scenario still discriminates on today's CLI/model (plugin-absent won't work — `bootstrap-installed` fails closed) |
| 0–1 | `mid-conversation-skill-invocation` | registration + subagent dispatch — only if the C2 probe confirms a subagent tool |

The persistence probe is a ~20-line scenario variant of
`superpowers-bootstrap` (new `scenarios/` entry, hermes-restricted initially).

**Decision rules (pre-registered):** bootstrap pass = ≥2/3; RED arm must fail
or all greens are void; any triggering fail escalates that cell to n=3 plus a
same-hour paired **pi** run (same model, credential — the attribution
control: hermes-fail+pi-pass isolates the delivery mechanism,
hermes-fail+pi-fail points at the model); every fail is checked for
compaction markers in `logs/agent.log` before it counts as PR evidence.

**Reporting limits:** existence proofs per claim, no reliability rates from
n≤3; compaction untested by design (say so anywhere results appear);
GLM-5.2-only; OpenRouter provider routing uncontrolled and unrecorded. For
each `skill-called` pass, triage records whether `skill_view` or the
`read_file` fallback matched — majority-fallback greens falsify the native
registration claim even in a green matrix.

### C6. Triage discipline

Non-passes attributed via `quorum show` + the triage atlas before they count;
indeterminates are harness debt, never PR evidence. The empty-capture path is
safe for this battery only because every cell's `post()` carries trace verbs
(composer forces indeterminate on `captureEmpty` + trace checks) — that
invariant is why deferring the hermes capture-cascade branch is acceptable;
any future scenario without trace verbs loses it.

## Provenance (experiment doc must record)

PR SHA (`pull/2025/head`, currently `b661305`); full multi-line
`hermes version` output incl. `upstream <hash>`; `HERMES_COMMIT` build arg;
both image IDs (pre/post rebuild); `evals-tool-versions` snapshot;
`GAUNTLET_ROOT` rev (gauntlet stamps no provenance of its own — known hole).
Pre-flight: OpenRouter credit balance and the Anthropic (Gauntlet-Agent) key
both verified before run 1 — a dead Anthropic key masquerades as coding-agent
capture failure. Post-campaign: rotate `OPENROUTER_API_KEY` (each run home
holds it in plaintext under `results/`).

## Out of scope (recorded follow-ups)

- `runtimeCleanupDirs` registration for `<home>/.hermes/.env` (key hygiene at
  the harness level; kimi precedent).
- `captureCascadeVerdict` / `STRICT_CAPTURE_NAMES` branch for hermes.
- `AGENT_INSTRUCTION_FILES` probe for hermes (`user-pref-*`).
- Nous Portal credential for Hermes-4-family evidence.
- Appliance enablement; obol 0.9.0 bump (own branch); gauntlet provenance
  stamping; skill_view content-fidelity probe scenario.

## Acceptance

1. `bun run check` green with C1–C3 landed; the real fixture normalizes to a
   priced trajectory (nonzero, no `UnknownModelForTurn`, `unpriced_models`
   empty) and the probe-verified tool names canonicalize.
2. Image rebuilt via `HERMES_COMMIT` with the old image retagged; smoke
   completes capture-intact on the new CLI under the committed pin.
3. Battery + RED arm + persistence probe run and triaged under the
   pre-registered rules; experiment log entry committed with the matrix,
   real costs, provenance block, and negatives at equal billing.

# Kernel D4a implementation validation and live exit runs

**Date:** 2026-08-31 (implementation record) · 2026-09-01 (portable gate + the
three live exit runs)
**Classification:** Portable implementation record plus the trusted-maintainer
live exit runs the D4a spec's §Exit criteria demand
(`docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md`).
**Outcome:** all three exit runs complete and verified; D4a's status line is
stamped `implemented (main @ 3cbb8d6)`; D3 §Exit criteria item 1 closes here.

## Local implementation ref

- **Worktree:** `/Users/drewritter/prime-rad/superpowers-evals/.qwen/worktrees/kernel-d4a`
- **Ref:** `460483a18d9b9a894824166fb2f492778bd8ba9d`
- **Branch:** `worktree-kernel-d4a`
- **Integration:** fast-forwarded onto `main` as linear commits (no merge
  commit); follow-up fixes through `3cbb8d6` (see "Route history" below).

## Portable evidence

The Task 5–9 implementation reports provide the portable evidence currently available:

| Report | Evidence recorded |
|---|---|
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-5-report.md` | Seal-act implementation and focused verification are recorded. The report also preserves earlier full-gate timeout history, so it is not treated as a refreshed final gate. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-6-report.md` | Resume-wiring implementation is recorded with successful repository and scenario-check receipts, and no live campaign. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-7-report.md` | Campaign-report implementation is recorded with focused verification and scenario checks; the report notes the unchanged full-repository Serf timeout. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-8-report.md` | Crash-window matrix implementation is recorded with successful full-gate and scenario-check receipts, and no live campaign. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-9-report.md` | Documentation implementation and the corrected D3/D4a operator-label evidence are recorded; the status stamp and live criteria remain pending. |

## Portable gate

### First attempt (2026-09-01, pre-integration)

The controller freshly attempted `bun run check`; it ended exit 1: 3448 pass, 1 skip, 3 fail, and 1 error. The failures were the timeout-prone `test/write-grid-manifest.test.ts` case and these two Serf credential cases in `test/runner-credential.test.ts`:

- `Serf credential runner integration > unlabeled and non-OpenRouter Serf credentials never call the attestation fetch seam`
- `Serf credential runner integration > OpenRouter attestation wrong provider stops before post-checks as capture indeterminate`

Focused probes then passed: `test/write-grid-manifest.test.ts` alone (2/2); the two named Serf cases with `bun test --timeout 20000 --test-name-pattern ...` (2/2); `bun run typecheck`; and `bun run lint`. `bun run quorum check` exited 0, and `git diff --check` was clean.

### Green on `3cbb8d6` (2026-09-01)

`bun run check` on `main @ 3cbb8d6` (the commit exit runs 2 and 3 ran
against): biome clean (495 files), `tsc --noEmit` clean, `bun test test/`
**3462 pass / 1 skip / 0 fail** (19,482 expect() calls, 232 files, 308.67 s),
dashboard workspace 144 pass / 0 fail; exit 0. `bun run quorum check` exit 0
(scenarios + arms + suites). The earlier timeout flakes did not recur; the
gate is green as written, with no timeout override.

## Route history (why the arms are direct-API)

The exit runs were planned on the Bedrock/Mantle route (the live claude
default since `a5f4e76`). Two things happened on the way:

- The direct Anthropic key in the blessed bundle was exhausted mid-session;
  Drew re-funded the org and rotated the bundle key, and the R-REG-15 gating
  rule (credential auth class) was rescinded (`e2aebf3`) so bedrock-bearer
  credentials could be projected into campaign children (`bbdc14c`).
- With the suites reshaped onto the bedrock route (`fcc11d8` + grader
  base-URL fix `891bad5`), the exploratory campaign `3ee40518…` allocated run
  `00-quorum-smoke-hello-world-claude-opus_bedrock-linux-20260901T201438Z-1a2a`
  (key grants `AWS_BEARER_TOKEN_BEDROCK` for subject and grader) and ~4.5 s
  later journaled `instrument_failure cause=capture_failed`; the run's
  `verdict.json` is `indeterminate` ("no Claude transcript appeared under
  isolated …/home/.claude/projects"), the Gauntlet-Agent never produced a run
  id, and the attempt adjudicated `unpriced_terminal` (R-JRN-12 forbids
  journaling an estimate as spend). Regular appliance `opus_bedrock` jobs on
  the same host are unaffected, so the defect is specific to the reconstructed
  campaign-child environment. **Filed as a follow-up; not diagnosed here.**

Per Drew's ruling ("gate on completed tests, not on arbitrary gates"), the
suites were returned to the direct-API route that had already sealed exit run
1 (`3cbb8d6`, a revert of `fcc11d8`): arms `d4a_live_claude_haiku`
(credential `haiku`) and `d4a_live_claude_sonnet46` (credential `sonnet46`,
the R-REG-13 distinct-pool treatment seat), grader `sonnet46` /
`claude-sonnet-4-6`, scenario `00-quorum-smoke-hello-world`, n = 1.

An earlier crash campaign on this route, `c7774464…`, was killed mid-dispatch
as collateral of a container-recreating appliance `prepare`; its resume
journaled `aborted` → `block_replaced (rerun, dispatcher_restart)` and
quarantined the foreign run dirs correctly, then stalled for reasons not
diagnosed. It exercised a dispatcher-era crash, not the terminus window, and
its D3-item-2 evidence chain (identity-guarded pgid kill, no double spend,
replay convergence) was not collected — it does **not** count toward D3 item
2 and is abandoned.

## Live validation

Access path: Tailscale SSH to `quorum-runner@quorum-appliance`; the campaign
verbs are break-glass through `scripts/evals-container … exec` with the
blessed credential env-file and the full expected container id (the
appliance helper has no campaign verb yet). Inside the container:
`GAUNTLET_ROOT=/tmp/gauntlet-live` (fresh clone, `91b6f7ef…`),
`SUPERPOWERS_ROOT=/workspace/superpowers` (`b36e0829…`). Campaign dirs live
under the appliance's gitignored `campaigns/`; run dirs under `results/`.
Total live spend for the three runs ≈ **$0.75**.

| Planned run | Result |
|---|---|
| Live run 1 exploratory | **PASS** — sealed + published, digest-verified re-render |
| Live run 2 gating | **PASS** — predicate-holds, typed D4b refusal; closes D3 item 1 |
| Live run 3 terminus crash | **PASS** — SIGKILL 3 ms into the terminus; resume sealed idempotently |

### Exit run 1 — exploratory lifecycle

- **Campaign:** `d5ac6fa77e129c5e9be9395ed293c7db47b4a44a1b815b8124c5b8bebf42b72e`
  (`campaigns/d5ac6fa7-d4a_live_exploratory`), suite `d4a_live_exploratory`,
  journal opened 2026-09-01T19:57:24.983Z; refs evals
  `4f58e310a328330ea0abf03ab8a57aecb01450e7`, gauntlet
  `91b6f7eff06c752a45dd0806d08779ea05798b02`.
- **Run:** `00-quorum-smoke-hello-world-claude-haiku-linux-20260901T195810Z-fa63`
  → `pass`.
- **Terminus:** `run_completed` 19:59:28.369Z → `sealed` 19:59:28.424Z (the
  whole spend-adjudication → snapshot-verify → integrity-audit → contention
  backstop → fold → seal → publish sequence took **55 ms**); report digest
  `48af9607f4204a66a2b18b35d210d4eda728773b2b4506e5b928da55548357ac`;
  `report.md` + `report.json` published md-first / json-last. 13 journal
  events.
- **Regeneration:** `quorum campaign report` exit 0; refolded digest equals
  the sealed digest, `report.md` byte-identical, `sha256(report.json)` equals
  the digest.
- **Spend:** $0.158292 (60,249 tokens).

### Exit run 2 — gating completion (closes D3 §Exit criteria item 1)

- **Campaign:** `1fc57f5d117b7c8443a865ac57edbd82c0651f526cbbf020d58ead3cb04f8c66`
  (`campaigns/1fc57f5d-d4a_live_gating`), suite `d4a_live_gating` (kind
  `gating`, profile `release_gate_v1`, baseline haiku / treatment sonnet46,
  pricing override `suites/pricing-overrides/d4a_live_gating.yaml`),
  registered with `--confirm`, journal opened 2026-09-01T21:39:07.759Z at
  evals `3cbb8d6`, gauntlet `91b6f7e`, superpowers `b36e0829…`.
- **Runs:** both samples of block `c1:00-quorum-smoke-hello-world:b1`
  admitted atomically at 21:39:38Z;
  `…-claude-sonnet46-linux-20260901T213938Z-f63b` → `pass` (21:40:45Z),
  `…-claude-haiku-linux-20260901T213938Z-1284` → `pass` (21:40:51Z); each
  produced its spend adjudication + `budget_event spend`. 22 journal events.
- **Refusal (the exit criterion):** with the seal predicate holding the
  leader emitted `sealing gating campaigns awaits D4b` and exited 1 with
  `error: campaign complete to the seal predicate; sealing gating campaigns
  awaits D4b — the campaign stays at predicate-holds (D3 exit criteria item 1
  closes here)`. No `sealed` event, no report artifacts. `quorum campaign
  report` refuses likewise: `campaign 1fc57f5d… registers release_gate_v1 —
  sealing/reporting gating campaigns awaits D4b`. This is the typed D4a
  refusal Decision D-5 pins; the campaign stays at predicate-holds for D4b.
- **Spend:** $0.438392.

### Exit run 3 — terminus crash + idempotent resume

- **Campaign:** `0e725906296eaedc13e4ea96d10afeef89ffef4a9ae0643f56d04303713e2999`
  (`campaigns/0e725906-d4a_live_crash`), suite `d4a_live_crash`, registered
  with `--confirm`, journal opened 2026-09-01T21:39:18.611Z, same refs as
  run 2.
- **Crash driver:** the `TerminusBoundary.onBoundary` seam is test-only (no
  production fault injection), so the kill is a real `SIGKILL` of the
  leader's process group. A watcher polled the journal (read-only SQLite) and
  killed pgid 2640 at **21:43:05.404Z, 3 ms after `run_completed`
  (21:43:05.401Z)** — inside the terminus sequence, which run 1 showed spans
  ~55 ms. Run `…-claude-haiku-linux-20260901T214155Z-26a7` → `pass`.
- **State at the cut:** journal ends at seq 16 (`budget_event spend`, after
  the seq 15 spend adjudication); no `sealed`, no report artifacts; the
  campaign-dir writer lease `journal.lease.d` and the host live-spend lock
  left behind by the dead leader.
- **Lock discipline (R-LCK-2):** `campaign run` refused to resume while the
  dead holder's heartbeat was younger than the 150 s stale threshold
  (`DEFAULT_HEARTBEAT_MS` 30 s × `DEFAULT_STALE_HEARTBEAT_FACTOR` 5): `held
  by pid 2642 (heartbeat …s old, campaign 0e725906…) — refuse, wait, or
  inspect the holder`. No lock was cleared by hand; the resume was retried
  every 20 s until reclaim was legal (heartbeat stale **and** holder proven
  dead, ESRCH) at 21:45:31Z.
- **Resume (R-RCV-5 hand-off):** `resume: the instance-complete seal
  predicate holds with no sealed event — report regeneration is owed`; the
  suffix appended after the cut is `quarantined ×6` (binding-only R-RCV-3
  identity-sweep events for the other campaigns' run dirs sharing the
  appliance `results/` root — the same six the launch sweep had already
  quarantined at seqs 2–7), `budget_event estimate_inflight ×2`, one
  `adjudication` (the contention backstop, `unknown_coverage`), then
  **`sealed` at seq 26, 21:45:31.480Z**, digest
  `6adac78e24d0d923120c1dafa1724a4978989b5b80a77379652aa7889289a3ca`;
  `report.md` (1576 B) and `report.json` (1057 B) published. The seq 15 spend
  adjudication was **not** duplicated (dedup held across the crash), and the
  lease dir was cleaned on exit.
- **Idempotence:** `quorum campaign report` exit 0 with byte-identical
  `report.md` and `sha256(report.json)` equal to the digest; a second
  `campaign run` refuses: `campaign already sealed — resume refused; quorum
  campaign report regenerates or verifies the readout`. 26 journal events.
- **Spend:** $0.150190.

**Design observation (conformant; for D4b):** the crashed campaign's report
carries its only block as `unknown_coverage: 1` (0/0 determinate, no
medians). The sensor sidecar died with the leader, so the last pre-crash
sample is 21:43:05.315Z and the resumed leader's sidecar took its first
sample at 21:45:31.435Z, 39 ms before the backstop evaluated. The shared
evaluator treats a real-sample gap wider than coverageN × cadence as
uncovering the whole gap, and the gap overlaps the block's exposure interval
[21:41:55.314Z, 21:43:05.401Z] by its final 86 ms — so the block is
`unknown`, never `contention`. Spec D-4 and terminus step 3 pin exactly this
("reduced n is the honest outcome, rendered loudly"). The consequence worth
carrying to D4b: a mid-terminus crash will always blind the final block's
tail unless the resume path can prove coverage some other way. No code
change was made.

## Exit-criteria status

- `bun run check` + `bun run quorum check`: green on `3cbb8d6` (above).
- Golden-oracle + digest-round-trip suites: part of the green portable
  matrix.
- Live runs 1–3: complete, recorded above.
- **D4a spec status:** stamped `implemented (main @ 3cbb8d6)` — a status
  stamp per the D2/D3 convention, never a semantic edit.
- **D3 §Exit criteria item 1 (completion):** closed by exit run 2 as pinned
  (Decision D-5).

## Remaining debt (owed, not started)

- **D3 item 2** (crash-resume mid-block: identity-guarded pgid kill before
  rerun, mint reuse, no double spend, replay convergence) and **D3 item 3**
  (cancel-and-refuse-resume with the pinned cancel order), the Linux-gated
  integration matrix (`test/integration/`, 13 asserted-not-proven items), and
  the D3 spec status stamp.
- **Bedrock/Mantle inside campaign children:** the `capture_failed` in
  campaign `3ee40518…` / run `…-1a2a` above. Until it is fixed the D4a live
  suites stay on the direct-API route on purpose (arm header comments say
  so); the campaign platform's bedrock default is therefore unproven live.
- The exit runs depended on a fresh gauntlet clone at `/tmp/gauntlet-live`
  inside the container (`/opt/gauntlet` is not a git repo, and `prepare`
  recreates the container, wiping `/tmp`); the appliance helper has no
  campaign verb, so campaign runs remain break-glass.

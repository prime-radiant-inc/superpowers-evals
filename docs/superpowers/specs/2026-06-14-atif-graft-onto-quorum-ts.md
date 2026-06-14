# Spec: graft ATIF + `check-transcript` onto `quorum-ts` (Matt's branch)

**Status:** proposal. **Premise:** adopt Matt's `matt/pri-2207-quorum-ts-spec2`
as the base (it's the more complete artifact — full spine, CLI, scheduler,
dashboard, green dual-gate CI) and replace its transcript + check layer with the
two things `feat/atif-port` did that Matt deliberately didn't: make **ATIF v1.7**
the canonical on-disk transcript, and replace the ~13 transcript-reading `bin/`
shell tools with the single TS `check-transcript <verb>` CLI.

This is the *only* place the two branches are architecturally incompatible.
Everything else on Matt's branch is kept as-is.

---

## 1. The seam today (both sides)

### Matt's pipeline (`quorum-ts`)
```
session logs → src/normalizers/* (→ ToolCall[])
            → src/capture writes coding-agent-tool-calls.jsonl  (flat: {tool,args,source} per line)
            → checks.sh sources bin/ trace tools, which read $QUORUM_TOOL_CALLS_PATH
            → bin/_record emits {check,args,negated,passed,detail} → $QUORUM_RECORD_SINK
            → src/checks/runPhase parses the sink → CheckRecord[]
            → src/composer.ts (TRACE_PRIMITIVES empty-capture guard) → verdict.json
```

### Our pipeline (`feat/atif-port`)
```
session logs → ts/src/normalize/* (→ ATIF Trajectory)
            → ts/src/quorum/capture.ts writes trajectory.json  (ATIF v1.7, multi-log merged)
            → checks.sh calls `check-transcript <verb>`, which reads $QUORUM_TRANSCRIPT_PATH,
              flattens the trajectory (atif/project.flattenToolCalls) → {tool,args} list
            → emits {check,args,negated,passed,detail} → $QUORUM_RECORD_SINK   ← SAME shape
            → (non-transcript checks: bin/ git-repo/file-exists/not/... unchanged)
```

### The lucky compatibilities (why this graft is cheap)
1. **Identical record contract.** `check-transcript` writes
   `{check,args,negated,passed,detail}` to `$QUORUM_RECORD_SINK` — byte-for-byte
   the shape Matt's `bin/_record` emits and his `runPhase` parses
   (`src/checks/index.ts` → `SinkRecordSchema`). No composer change needed.
2. **Same flat projection.** Our check verbs operate on a flat `{tool,args}`
   list (`ToolCallView`), exactly like Matt's `ToolCall[]`. ATIF is a *superset*
   on disk; `flattenToolCalls` projects it down to what checks need. The only
   transcript consumer is the check layer, so the richer artifact is safe/additive.
3. **Composer already guards.** Matt's `src/composer.ts` already has
   `TRACE_PRIMITIVES` and forces `indeterminate` when capture is empty and any
   check name is a trace primitive. Our records use those exact verb names
   (`tool-called`, …), so the guard keeps working.
4. **`runPhase` already does the env+PATH+sink ceremony.** It prepends `quorumBin`
   to PATH and sources `checks.sh`. `check-transcript` just needs to resolve on
   that PATH (ship `bin/check-transcript` as a thin bun shim) and the runner needs
   to set `QUORUM_TRANSCRIPT_PATH` alongside/instead of `QUORUM_TOOL_CALLS_PATH`.
5. **The hard parts are already written and parity-locked** on `feat/atif-port`:
   ~1090 LOC ATIF+check+detect+CLI, ~1299 LOC of 8 ATIF normalizers, ~553 LOC
   ATIF multi-log-merge capture — all with ported tests + a Python-oracle
   differential harness. The graft is mostly *moving* this code and rewiring two
   I/O points, not writing it.
6. **The flipped scenarios already exist.** 43 of 55 scenarios have transcript
   checks; `feat/atif-port` already has every one of them rewritten to
   `check-transcript <verb>`. They can be reused wholesale.

### The non-overlap (untouched)
The other ~18 `bin/` tools are **not** transcript checks — `git-repo`,
`git-branch`, `git-clean`, `git-count`, `file-exists`, `file-contains`,
`command-succeeds`, `assert-checkout-clean`, `requires-tool`, the six
`*-plugin-installed`, `codex-native-hook-configured`, `gemini-extension-linked`,
`refresh-claude-home-skeleton`, and the `not` wrapper + `_record`. They read
git/filesystem state, not the transcript. **They stay exactly as Matt has them.**
Only the 13 trace verbs move into `check-transcript`.

---

## 2. Target architecture (after the graft)

```
session logs → src/normalize/* + src/atif/*   (→ ATIF Trajectory)   [ours, moved in]
            → src/capture writes run_dir/trajectory.json (ATIF, merged) [Matt's capture, rewired output]
            → checks.sh: trace checks = `check-transcript <verb>`; git/fs checks = bin/ (unchanged)
            → check-transcript reads $QUORUM_TRANSCRIPT_PATH → {check,...} → $QUORUM_RECORD_SINK
            → src/checks/runPhase (unchanged) → CheckRecord[]
            → src/composer.ts (unchanged; TRACE_PRIMITIVES still valid) → verdict.json
```

Canonical transcript type becomes `AtifTrajectory` (`src/atif/types.ts`). Matt's
`ToolCallSchema`/`ToolCall` in `contracts/verdict.ts` is no longer the transcript
artifact; keep it only if some other consumer still wants the flat zod type
(grep says only capture+checks consume it today, so it can likely be deleted).

---

## 3. Work breakdown — the full switch

Disjoint, mostly mechanical. Each is a task in an eventual plan.

- **A. Move the transcript producer.** Copy `feat/atif-port` `ts/src/atif/*`,
  `ts/src/normalize/*`, `ts/src/detect/*` into Matt's `src/atif`, `src/normalize`,
  `src/detect`. Delete `src/normalizers/*` (his ToolCall[] normalizers). Reconcile
  imports to Matt's layout + biome style.
- **B. Rewire capture output.** Point `src/capture/index.ts` at
  `run_dir/trajectory.json` and have it produce a merged ATIF trajectory (port the
  merge from our `ts/src/quorum/capture.ts`: multi-log, timestamp-ordered, stable
  fallback, `step_id` renumber). `rowCount` = flattened tool-call count (preserves
  the PRI-2081 empty-capture retry semantics he already mirrors). Drop the
  `coding-agent-tool-calls.jsonl` write (or keep it transitionally behind a flag —
  see MVP).
- **C. Move the check consumer.** Copy `ts/src/check/*` and
  `ts/src/cli/check-transcript.ts` into Matt's `src/check` + `src/cli`. Add
  `bin/check-transcript` (thin shim: `exec bun run "$repo/src/cli/check-transcript.ts" "$@"`,
  matching how the other `bin/` tools resolve). Delete the 13 trace `bin/` tools.
- **D. Runner env.** In the call site that builds `runPhase` args (the runner),
  set `QUORUM_TRANSCRIPT_PATH=<runDir>/trajectory.json`. Keep
  `QUORUM_TOOL_CALLS_PATH` only if (B) keeps the transitional flat file; otherwise
  remove it.
- **E. Scenarios.** Replace each transcript check in `scenarios/*/checks.sh`
  (`tool-called X` → `check-transcript tool-called X`, etc.). Source the 43
  already-flipped files from `feat/atif-port`; diff-verify the non-transcript lines
  are unchanged from Matt's versions.
- **F. Composer.** No change required. Optional hardening: close the latent
  `not check-transcript <verb>` gap (a `not`-wrapped transcript check records
  `check:"check-transcript"`, not the verb, so it would dodge the
  `TRACE_PRIMITIVES` guard). Today every transcript negative uses a dedicated
  verb (`tool-not-called`/`skill-not-called`), so it's not currently reachable —
  document or fix by having `not` record the inner verb.
- **G. Tests.** Bring over our `atif`/`check`/`normalize`/`detect` tests. Extend
  Matt's replay-differential oracle with a **check-record parity** assertion: for
  each replay fixture, run a fixed set of verbs through BOTH the old bin/ path
  (his ToolCall[] JSONL) and the new ATIF path (`check-transcript`) and assert the
  emitted CheckRecords match. This is the regression fence for the cutover.
- **H. CI/lint.** Ensure the moved files pass `biome check` + `tsc` on Matt's
  config; add `check-transcript`/`trajectory.json` to any `.gitignore`/CODEOWNERS
  as needed.

Dependency note: ATIF carries `subagent_trajectories`, `reasoning_content`,
`observation`, `metrics` — none consumed by checks today, but they're now
available for the dashboard or future verbs at zero extra capture cost.

---

## 4. MVP — smallest end-to-end proof (no live agent)

**Goal:** prove the swap is behavior-preserving for ONE agent (claude) on the
trace verbs, using an existing replay fixture, before touching all 8 agents /
55 scenarios.

1. **Drop in the claude slice only:** `src/atif/{types,project,validate}.ts`,
   `src/normalize/claude.ts`, `src/detect/*`, `src/check/*`,
   `src/cli/check-transcript.ts`, `bin/check-transcript`.
2. **Differential check-record test** (the keystone). Take a real claude
   session-log replay fixture (Matt already mines these for his oracle). For a
   fixed verb set (`tool-called`, `tool-not-called`, `tool-count`, `tool-before`,
   `skill-called`, `skill-not-called`, `tool-arg-match`):
   - **Path A (Matt's):** `normalizeClaudeLogs` → `coding-agent-tool-calls.jsonl`
     → run the corresponding `bin/` tools with `QUORUM_TOOL_CALLS_PATH` +
     `QUORUM_RECORD_SINK` → collect sink records.
   - **Path B (ATIF):** our claude normalize → `trajectory.json` → run
     `check-transcript <verb>` with `QUORUM_TRANSCRIPT_PATH` + `QUORUM_RECORD_SINK`
     → collect sink records.
   - **Assert** the `{passed}` (and, where defined, `detail`) match per check.
3. **One scenario through the bridge.** Pick one claude trace scenario; flip its
   `checks.sh` transcript lines to `check-transcript`; set
   `QUORUM_TRANSCRIPT_PATH` in `runPhase`; run `post()` against the fixture
   trajectory via Matt's existing `runPhase`; confirm the same verdict the bin/
   path produced.

**Exit criteria:** identical CheckRecords across both paths for the claude
fixture, and one scenario green through the new path. That validates the entire
contract (capture format → env → CLI → record shape → runPhase → composer) on
the cheapest possible surface. Rollout to the other 7 normalizers + 43 scenarios
is then repetition of a proven pattern (each normalizer already has its own
replay fixture + differential test on `feat/atif-port`).

**MVP cost:** small — the code already exists and is parity-locked; the MVP is
~the claude differential test + the bin/check-transcript shim + one capture
output rewire + one scenario flip. The full switch is a focused subagent-driven
plan (one task per item in §3, normalizers/scenarios fanned out).

---

## 5. Risks / open questions

- **Two transcript artifacts during cutover.** Cleanest to keep
  `coding-agent-tool-calls.jsonl` *and* `trajectory.json` written for one cycle
  (flag-gated) so the differential oracle can compare on real runs; delete the
  flat file in a follow-up once green. Decide at (B).
- **`detail` string parity.** Records' `detail` text differs in wording between
  bin/ tools and `check-transcript` (it's human text). The composer ignores
  `detail` for the verdict, so assert on `{passed}` for parity; treat `detail`
  as informational. Confirm no scenario or test greps `detail`.
- **`tool-arg-match` arg surface.** This verb's caller-side flag shape
  (`--matches key=…`, `--ignore-case`) must match what the ~6 scenarios using it
  expect; verify during the scenario flip (E).
- **biome vs our style.** Our files were written for `tsc`+ruff-free TS; expect a
  `biome check --write` pass on the moved files. Mechanical.
- **Do we keep ATIF plain or zodify it?** Matt's house style is zod contracts;
  ours is plain interfaces + a hand-rolled `validateTrajectory`. Lowest-friction:
  keep ATIF as-is (it has its own validator) and don't force it through zod.
  Revisit only if the dashboard wants a zod view-model over the trajectory.
- **Is the ATIF bet worth it here at all?** Honest framing for the decision: the
  payoff is a documented, validated, superset transcript (subagent trees,
  reasoning, observations, metrics) + a single check binary instead of 13 shell
  tools. The cost is this graft + carrying ATIF as the format Matt didn't choose.
  If the answer is "no," Matt's flat `ToolCall[]` + bin/ is a fully working
  resting state and this spec is shelved.

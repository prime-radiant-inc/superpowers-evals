# 2026-07-17 — PR #1998 (SDD fix-loop redesign): independent eval campaign pre-registration

Pre-registration for the independent replicate-and-extend campaign against
obra/superpowers#1998 (`sdd-fix-loop-redesign`), per
`docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md` and
`docs/superpowers/plans/2026-07-17-pr1998-eval-campaign.md`. Ticket:
PRI-2650. This entry is written before any measured run and is filled in as
the campaign proceeds — negative results get equal billing with wins.

## Hypotheses

Copied verbatim from the spec's "Objective and decision rule" section.

Four claims get independently tested:

1. The redesign's breaker/park/BLOCKED behaviors hold (GREEN replication).
2. dev genuinely exhibits the motivating defects, including the coin-flip
   mechanism split at a real n (RED replication).
3. codex handles fix rounds through a sanctioned route — native resume if
   the harness supports it, else the specified (never-yet-run) fallback.
4. Core redesign mechanics nobody has probed — round-4 escalation to a
   more capable model, findings-scoped re-review — actually happen.

## Config

- **DEV_PIN (control):** `fb7b07088ed03da76508b8a70a87bf4f15b2412a` —
  superpowers `dev` tip, resolved via
  `git ls-remote https://github.com/obra/superpowers.git refs/heads/dev` on
  2026-07-17. Same tip the 2026-07-15/16 #1943 panels used (`fb7b07088ed0`
  short) — dev has not moved since.
- **Treatment:** PR #1998 head `1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`
  (`1f97eda`) — confirmed via
  `gh pr view 1998 --repo obra/superpowers --json headRefOid` on 2026-07-17;
  matches the spec's pin exactly. A force-push mid-campaign stops affected
  blocks and re-pins (spec contingency, noted here if it happens).
- **Credentials:** claude → `opus_bedrock` (appliance default; this branch
  carries `max_concurrency: 6`, quota probed 2026-07-16, PRI-2650 — see
  `credentials.yaml`). codex → explicit `--credentials openai_responses`
  (the appliance `codex_sub` default has no auth seeded).
- **Grader:** harness-pinned `claude-sonnet-5` (billed on the shared
  direct-Anthropic key, separate exhaustible budget from the coding-agent
  credentials — top up and re-check between batches per the spec's
  preflight).
- **Appliance:** shared `evals-appliance` (Tailscale). `evals_ref` is
  pinned to evals `main` — unmerged scenario/route-extension work cannot
  produce measured runs until it merges and the box syncs. Preflight
  (doctor/prepare both arms, grader credit check, obol pricing check ≥0.8.0)
  precedes any measured run.

## Pre-registered protocols

Copied verbatim from the spec's "Measurement protocols" section.

- **Block 2 — mechanism classification (pre-registered):** scenario
  verdicts are outcome-gated and do *not* measure mechanism. Every dev-arm
  run of `sdd-fix-loop-resumes-implementer` (n=7) gets a transcript read
  classifying it: {resumed implementer, fresh/dedicated fix dispatch,
  pre-flight defused, other}. Criterion: the coin-flip claim is
  *supported* if ≥2 distinct mechanisms are each observed ≥2× among runs
  that entered a fix cycle; if <4 runs enter a fix cycle, the block is
  reported as underpowered — not adjudicated either way.
- **Blocks 4–6 — resume sweep (pre-registered):** every treatment-arm
  transcript is swept for organic fix cycles; each is classified with the
  block-2 taxonomy. Organic rounds 1–3 resumes are the only obtainable
  live-resume evidence (see observability limit above).
- **Codex capability precheck (before block 3):** establish whether codex
  can send a follow-up message to a live spawned agent (docs + a cheap
  local probe, not an appliance run). Outcome sets block 3's expected
  route; the route actually taken is read from each transcript.
- **Triage-triggered pairing:** blocks 4–6 run controls only on a fail,
  but never as a lone late-window control — a fail triggers a fresh
  *contemporaneous pair* (treatment + control submitted together), which
  is what the nonstationarity doctrine permits.

(The "see observability limit above" cross-reference is to the spec's
"Known observability limit" paragraph, `docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`:
every seeded-restart fixture kills the live implementer, so rounds 1–3
*live* resume cannot be forced by any seeded scenario — only observed
organically, which is what the sweep above is for.)

## Codex capability precheck

**EXPECTED_ROUTE = `native-resume`.** High confidence. codex has a working
send-message-to-a-live-agent primitive; the harness's known primitives are
not limited to `spawn_agent`/`wait_agent`/`close_agent`. This gates block
3's expected route (task 10 reads the route actually taken per-transcript
against this expectation).

### Document trail

This repo's own artifacts only ever named the 3-primitive surface:

- `src/normalize/codex.ts`: `"spawn_agent aliases to Agent (1:1 with a
  subagent launch). wait_agent and close_agent are async-protocol
  join/teardown calls..."` — `CODEX_TOOL_MAP = { spawn_agent: 'Agent' }`.
- `src/setup-helpers/codex-app-server.ts` speaks JSON-RPC to
  `codex app-server --listen stdio://`, but only for `initialize` +
  `hooks/list` (querying the staged Superpowers SessionStart hook at
  provision time) — it never touches agent spawn/message/wait/close and is
  silent on the question.
- `coding-agents/codex-context/HOWTO.md` documents driving the top-level
  codex TUI session (launch, rollout-log tailing, `wake_on_idle_log`) and
  says nothing about subagent messaging.
- `coding-agents/codex.yaml`: `normalizer: codex`, `default_credential:
  codex_sub` — no model/tool-surface detail.

But the *superpowers reference the codex coding-agent under test actually
reads* already anticipates exactly this uncertainty. Quoted verbatim from
`skills/using-superpowers/references/codex-tools.md` in the superpowers repo
(`SUPERPOWERS_ROOT`, checked at `/Users/drewritter/prime-rad/superpowers`,
branch `sdd-fix-loop-redesign`):

> "This enables `spawn_agent`, `wait_agent`, and `close_agent` for skills
> like `dispatching-parallel-agents` and `subagent-driven-development`. When
> using subagent-driven-development, close reviewer subagents when their
> review returns. Keep each implementer subagent open until its task's
> review passes — the fix loop resumes the implementer — then close it. If
> your harness cannot send another message to a spawned agent, dispatch each
> fix round as a fresh implementer carrying the brief, the report file, and
> the findings."

And `skills/subagent-driven-development/SKILL.md` (the skill under test),
section "4. The fix loop":

> "**Rounds 1-3 — resume the original implementer.** Send it the open
> findings verbatim. Its context is intact: it knows the task, the code, and
> its own choices. If your harness cannot send another message to a live
> subagent, dispatch a fresh implementer carrying the brief path, the
> report-file path, and the findings — the report file is the persistent
> memory either way."

This confirms the task's `native-resume`/`fallback` terminology is not
invented for this campaign — it's load-bearing language already in the
skill the coding-agent is graded against. Absence of a fourth primitive in
*our* normalizer/docs is explicitly not proof codex lacks one, hence the
empirical probe below.

### Static binary evidence (corroborating, not decisive alone)

`strings` over the host's installed codex binary
(`~/.bun/install/global/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
`codex-cli 0.142.0`) turned up embedded Rust source paths and tool-schema
description strings:

```
core/src/tools/handlers/multi_agents/close_agent.rs
core/src/tools/handlers/multi_agents/resume_agent.rs
core/src/tools/handlers/multi_agents/spawn.rs
core/src/tools/handlers/multi_agents/send_input.rs
core/src/tools/handlers/multi_agents/wait.rs
```

and, verbatim, tool descriptions including:

> `send_input` — "Send a message to an existing agent. Use interrupt=true to
> redirect work immediately. You should reuse the agent by send_input if you
> believe your assigned task is highly dependent on the context of a
> previous task."
>
> `resume_agent` — "Resume a previously closed agent by id so it can
> receive send_input and wait_agent calls."

So the binary ships a 5-handler `multi_agents` module
(`spawn`/`send_input`/`wait`/`close_agent`/`resume_agent`), not 3. This is
static evidence only — it doesn't prove the tool is *exposed to the model*
or *actually works* on a live agent; the empirical probe settles that.

### Empirical probe

Host `codex` CLI (`codex-cli 0.142.0`), ChatGPT-subscription auth
(`auth_mode: chatgpt`, confirmed via `codex doctor`), non-interactive
`codex exec`, cheapest catalog model (`codex debug models` →
`gpt-5.4-mini`, "Small, fast, and cost-efficient model for simpler coding
tasks"), `model_reasoning_effort=low`, in an isolated non-repo scratch
directory (`--skip-git-repo-check -s workspace-write`), `multi_agent`
feature already `stable=true` by default (`codex features list`).

Prompt instructed the agent to: spawn one trivial subagent running
`sleep 8` then replying `SUBAGENT_DONE`; before calling `wait_agent` or
`close_agent`, find and call whatever tool sends an additional message to
that still-live agent, with text `PROBE_FOLLOWUP`; then `wait_agent` +
`close_agent`; then report tool names, the exact call, and the exact
result, verbatim.

Ground truth is the raw `--json` event stream (not the model's self-report,
which matched it anyway). The decisive sequence:

```
item_3  collab_tool_call tool=spawn_agent  → receiver_thread_ids=["019f6f24-235e-…"], agents_states={"019f6f24-235e-…":{"status":"pending_init"}}
item_4  collab_tool_call tool=send_input   prompt="PROBE_FOLLOWUP" receiver_thread_ids=["019f6f24-235e-…"]
        → status="completed" (no error), agents_states={"019f6f24-235e-…":{"status":"running"}}
item_5  collab_tool_call tool=wait         → agents_states={"019f6f24-235e-…":{"status":"completed","message":"SUBAGENT_DONE"}}
item_6  collab_tool_call tool=close_agent  → same completed state
```

The model self-reported its full agent-tool list as exactly `spawn_agent`,
`send_input`, `wait_agent`, `close_agent`, `resume_agent` (5 tools — the
binary's `send_message`/`followup_task` description strings were not in
this session's live tool list, so treat those two names as not confirmed
exposed under this config; `send_input` is). It called `send_input` with
`{"target": "019f6f24-235e-7580-9f63-148a44dbd573", "message":
"PROBE_FOLLOWUP"}` and got back `{"submission_id":
"019f6f24-4017-7753-a6b7-e1fc6f6e74c0"}` (per the model's self-report; the
raw `--json` stream shows the call's non-error completion and the target's
pending_init→running transition, which are the ground-truth anchors) —
success, not an error. The raw event confirms the target's `agents_states`
was `"running"` (i.e. genuinely live, not `pending_init` or `completed`) at
the moment `send_input` was accepted.

**Caveat (not a blocker, flagged for task 10):** `send_input` without
`interrupt=true` *queues* the message rather than interrupting immediately
(per its own description string). The subagent's final message was exactly
`SUBAGENT_DONE` — the original task's literal expected output — with no
visible trace of having consumed `PROBE_FOLLOWUP`. This transcript alone
doesn't prove a queued message is reliably *acted on* by the target agent
before it finishes its turn; it proves the primitive exists, targets a live
agent, and the runtime accepts it without error. Whether a real fix-round
resume (findings sent while the implementer is mid-task) gets consumed
reliably is exactly what block 3's organic-transcript sweep should confirm
or refute.

**Version-drift note:** host codex is `0.142.0`; the eval appliance/CI
images observed across recent campaigns range `0.140.0`–`0.144.3`
(`docs/experiments/2026-07-06-skill-edit-campaign-1932-1935.md`,
`docs/experiments/2026-07-14-codex-gpt56-sol-vs-gpt55.md`), so this probe's
build is representative of the range actually in use, not a stale outlier.

Full probe transcript (raw prompt, JSONL events, model's last message):
task report `.superpowers/sdd/task-9-report.md`.

## Verdicts

Empty per-block tables, mirroring the spec's Run matrix block names and
planned n per cell. Filled in as runs land; no outcomes pre-filled.

### Block 0 — Scenario audit

No runs (fix-before-run gate: hostile read of the 3 new scenarios' checks/
fixtures for false-pass holes, incl. non-ASCII literal traps, plus closing
the planted-defect false-pass residual).

Hostile 3-point audit of `sdd-breaker-structural-blocks`,
`sdd-breaker-adjudicates-at-cap`, `sdd-fix-loop-resumes-implementer`
(`checks.sh` + `story.md` + their fixtures in
`src/setup-helpers/sdd-fixtures.ts`), against SKILL.md pulled directly from
the PR head commit (`1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`) rather than
trusted secondhand.

| Scenario | 1. Non-ASCII literal traps | 2. False-pass holes | 3. Negation coverage |
|---|---|---|---|
| sdd-breaker-structural-blocks | clean — 0 non-ASCII bytes in checks.sh | **fixed** — post() was 3 negative fs checks + 1 positive transcript check and nothing else; `not` inverts a plain (non-`broken`) missing-file fail to PASS, so a wiped `.superpowers/sdd/progress.md` (SKILL.md itself warns `git clean -fdx` destroys it) would trivially satisfy every `not file-exists`/`not file-contains`. Added `file-exists '.superpowers/sdd/progress.md'` to post(). | clean, 1 recommend-only note (①) |
| sdd-breaker-adjudicates-at-cap | clean — the sole non-ASCII hit, `'Task 2: parked —'` (U+2014), is mandated verbatim by SKILL.md at `1f97eda` (`` `Task <N>: parked — <finding> — ruling: <why>` ``); byte-identical, verified independently. Correct as-is. | clean — none of the 4 positive `file-contains` literals (`Task 2: parked —`, `ruling:`, `Task 3: complete`, `Task 2: complete`) appear in the ledger `scaffoldSddMidloop`/`scaffoldSddMidloopParked` seed (ledger only has `Task 1: complete`, `Task 2: implementer DONE`, 5× fix-round lines); corroborated by existing `test/setup-helpers-sdd.test.ts` assertions | clean, 1 recommend-only note (①); also structurally immune to the wipeout hole above — its 4 positive checks on the same ledger fail outright if the file is missing |
| sdd-fix-loop-resumes-implementer | clean — 0 non-ASCII bytes | clean — the 2 positive `file-contains` checks target `src/report.js`, which `scaffoldSddResumeTriggerPlan` never creates (only `package.json` + the plan file are seeded), so it cannot be pre-seeded | clean — both "Hard FAIL" mechanism clauses (fresh-Agent-generic-prompt dispatch; controller self-editing between reviews) are explicitly judge-owned: the AC says "Identify from the session log which route fired," matching this campaign's own pre-registered Block 2 mechanism-classification protocol (transcript read, not a deterministic check) for this exact scenario family |

① Recommend-only, not fixed: both breaker scenarios' story.md names a fail
mode with no ledger-literal requirement at all — scenario 1's "it silently
burns more fix rounds on Task 2" and scenario 2's "an implementer or fix
dispatch re-attempting the parked finding." Both are covered only by the
ledger-literal negative check (`not file-contains ... 'fix round 6'`); a
re-dispatch that never gets written to the ledger in that exact form slips
past it. Closing this deterministically needs a transcript content-match
(e.g. `tool-arg-match Agent --matches prompt=<pattern>`) tied to a specific
regex — picking that pattern risks over/under-matching legitimate Task 3
dispatches, which is a semantics-changing addition, not a smallest fix.
The Gauntlet-Agent judge still grades the underlying AC from the full
transcript regardless of this deterministic gap.

**Fix applied:** `scenarios/sdd-breaker-structural-blocks/checks.sh`
post() gained one line (`file-exists '.superpowers/sdd/progress.md'`). No
other scenario or fixture file changed — `src/setup-helpers/sdd-fixtures.ts`
was found correct on inspection.

**Validation:** `bun run quorum check` — all scenarios `ok`, including all
3 audited (no `fail`/`broken` lines). `bun test test/setup-helpers-sdd.test.ts`
— 13 pass / 0 fail / 57 expect() calls.

**Tally:** 1 finding fixed, 2 findings recommend-only (one underlying gap
surfaced identically in both breaker scenarios, not fixed), 6 of 9
checklist cells fully clean with no caveat.

**Status:** COMPLETE.

### Local iteration (non-measured) — Task 14 Step 1

Per the plan's Global Constraint "Local slim-container runs are iteration
only and never count," these three runs are **not** campaign observations —
they exist only to shake out fixture/check bugs in the three new probe
scenarios (`sdd-round4-escalates-model`, `sdd-re-review-scoped`,
`sdd-final-review-single-wave`) before any appliance money is spent. Config:
coding agent `claude` (Claude Code 2.1.202, `superpowers-evals:local` local
container image — see Deviations below), credential `opus` (direct
Anthropic API — the local container has no Bedrock bearer token seeded),
treatment root = clean clone of PR head `1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`
at `/tmp/pri2650-superpowers`. One run per scenario.

| Scenario | Verdict | Triage | Cost |
|---|---|---|---|
| `sdd-round4-escalates-model` | pass | clean pass | $2.19 |
| `sdd-re-review-scoped` | fail | **legitimate defuse** (negative result) | $2.36 |
| `sdd-final-review-single-wave` | pass | clean pass | $1.54 |

**`sdd-round4-escalates-model` — pass, verified independently of the judge.**
Raw session-log inspection (not just the judge's summary) confirms: the
round-4 fix dispatch (`description: "Task 2 round 4 fix"`) carries an
explicit `model: sonnet` field — one tier above the ledger's recorded stuck
implementer (`claude-haiku-4-5`) — and its own re-review dispatch is
correctly scoped (`"Re-review Task 2 fix round 4"`, not a fresh review). No
round 5/6 dispatch occurred. Ledger and `npm test` both consistent. No
fixture or check bug found.

**`sdd-re-review-scoped` — fail, triaged as a legitimate defuse, not a bug.**
The judge failed the run because round 2's fix dispatch did not carry both
open findings — it explicitly told the implementer to ignore the
"missing input guard in formatDuration" finding. Investigated against the
raw transcript and SKILL.md at `1f97eda` before accepting this triage:

- The agent used `AskUserQuestion` to flag that the finding conflicts with
  the plan's Task 2 spec, which states the parameter contract verbatim:
  `seconds`: "a non-negative integer count of seconds." Verified against the
  actual seeded `docs/superpowers/plans/metrics-plan.md` in the run's
  workdir — the agent's citation is accurate, not fabricated.
- SKILL.md's fix-loop section (§4) states explicitly: "A finding labeled
  plan-mandated — or any finding that conflicts with what the plan's text
  requires — is the human's decision, like any plan contradiction: present
  the finding and the plan text, ask which governs," and this is one of
  "two routes [that] leave [the loop] immediately" **before** the
  round-numbered loop starts.
- The story script answers "Your call — follow your skill" to any
  procedural question, which the agent correctly treated as a
  skill-conformant delegation, not resolution of the plan-conflict question
  itself — it picked the recommended, plan-consistent option and wrote a
  ledger `ruling:` line explaining the decision.
- The `tool-arg-match` deterministic check passed even though the finding
  was dropped, because the finding's text appears in the round-2 prompt in
  a negating clause ("A separate finding about a 'missing input guard' was
  DROPPED — ignore it"). This is the exact, disclosed limitation in
  `checks.sh`'s header comment ("necessary but not sufficient evidence for
  'scoped'") — not a check regression; the judge is doing exactly the job
  the deterministic floor was designed to hand off.

This is the same "skill's rich judgment machinery defeats a seeded
assumption" pattern the `sdd-fix-loop-resumes-implementer` scenario
family hit repeatedly (see `docs/experiments/2026-07-sdd-fix-loop-redesign.md`).
The scenario's story.md AC2 implicitly assumed both seeded findings would
enter round 2 together; it did not anticipate SKILL.md's own
plan-mandated-conflict carve-out, which a correctly-reasoning agent is
supposed to take. **No AC reshaping performed** — flagged to the controller
per the 5a–5d discipline instead of acted on. No re-run (not a bug; budget
would not have sanctioned one anyway).

**`sdd-final-review-single-wave` — pass, verified independently of the
judge.** The seeded fixture's final review is expected to surface two
genuinely review-findable, undiscovered warts alongside the one
already-parked finding (per `task-13-report.md`'s fixture design). Raw
ledger inspection confirms the single `Agent` dispatch (`"Final
whole-branch code review"`, the only Agent call in the whole session, as
expected — all three tasks were pre-seeded complete) caught the seeded
`summary.js` dead-branch duplicate-logic wart and rated it Minor
(non-blocking, matching its actual quality-only/no-behavioral-impact
character), confirmed the already-parked `formatDuration` finding
non-blocking, and correctly took the zero-fix-wave path. This exactly
matches SKILL.md's own worked example (`"Final reviewer: All requirements
met. Deferred minors triaged: none block merge." → "Done!"` — no fix wave,
no re-review dispatched when nothing returned needs fixing), which the
judge cited directly. Story.md's AC2/AC3 wording ("fixed in ONE fix
dispatch," "not skipped outright") reads naturally as conditioned on the
final review returning something that needs fixing; this run's seed
happened to return only Minors, so the zero-fix-wave path is the
skill-correct outcome, not evidence the AC is untestable. No fixture or
check bug found.

**Deviations from the plan's local-iteration description (documented, not
silently substituted):**

- **Image**: the plan text names `container/Dockerfile.claude-slim`, but
  `scripts/evals-container` has no mechanism to select it — its `build`
  command is hardcoded to `container/Dockerfile` (the full 15-agent image)
  under a fixed tag `superpowers-evals:local`. That image already existed
  on this host, freshly built 3 days prior (`claude-code@2.1.202`, one
  patch behind the worktree's current pin of `2.1.209` from
  `6a0aba8`, dated one day after the image build). Used as-is rather than
  rebuilt — code executes via the live bind mount of this worktree
  (`repoRoot()` is filesystem-path-derived, not baked into the image), so
  only the OS/toolchain layer is affected, and a 1-patch claude-code
  version delta is immaterial to fixture/check-bug shakeout. Two other
  images present on the host, tagged `quorum/claude:latest` and
  `quorum-base:latest`, turned out to be ~5-week-old relics of an
  unrelated, superseded Python-based quorum generation (`uv`/`pyproject.toml`
  layout) — not usable by this repo's wrapper at all; not used.
- **Worktree `.git` pointer**: this checkout is a git worktree; its `.git`
  file points at `<main-checkout>/.git/worktrees/pri-2650-pr1998-campaign`,
  a path the container does not mount (only the worktree itself and the
  clean superpowers clone are mounted). `git status`/`git rev-parse` fail
  inside the container for `/workspace/evals`. Traced the only consumer
  (`src/runner/provenance.ts`'s `collectProvenance`) — it is an explicitly
  best-effort, fallible-by-design probe ("a probe failure yields null for
  that field and MUST NOT fail the run"); the only effect is a null
  `harness_rev` in each run's `verdict.json`. Confirmed benign; not fixed
  (fixing it would mean mounting the main checkout's `.git` dir into the
  container, out of scope for this task).
- **Credential**: `credentials.yaml`'s `opus_bedrock` (the appliance
  default for claude) needs `AWS_BEARER_TOKEN_BEDROCK`, which is not
  provisioned locally. Used `--credential opus` (direct Anthropic API,
  `ANTHROPIC_API_KEY`) instead, sourced from the main checkout's
  `.env` (this worktree has none of its own — expected, `.env` is
  gitignored per-checkout). Matches the precedent in
  `docs/experiments/2026-07-sdd-fix-loop-redesign.md`'s own local-container
  config.

**Economics:** 3 runs, $6.09 total ($1.54–$2.36 each, all under the $3–4
estimate).

**Tally:** 0 fixture/check bugs found across all 3 new scenarios; 2 clean
passes, 1 legitimate-defuse fail (documented negative result, not a bug).
No commits to `scenarios/` or `src/setup-helpers/` from this task — nothing
needed fixing.

**Status:** COMPLETE. Interpretability bar met for all 3 probes; Task 14
Step 2 (PR) and Step 3 (box sync) remain deferred to the controller per the
task dispatch.

**Correction (see follow-up subsection below):** the "legitimate defuse"
triage above for `sdd-re-review-scoped` was itself the symptom of a fixture
bug, not a skill-behavior finding — the seeded "missing input guard in
formatDuration" finding genuinely conflicted with the seeded plan's own
verbatim contract, so SKILL.md's pre-loop plan-conflict carve-out was the
*correct* thing for the agent to take; the seed, not the AC, was wrong.
Controller ruling: fix the seed. Closed below.

### Local iteration re-run — sdd-re-review-scoped fixture fix (follow-up)

Controller ruling on the Task 14 Step 1 "legitimate defuse" triage above:
the dropped finding, "missing input guard in formatDuration," textually
conflicts with the seeded plan's own Task 2 contract ("Takes one parameter
`seconds`: a non-negative integer count of seconds") — so SKILL.md's §4
pre-loop carve-out ("A finding labeled plan-mandated — or any finding that
conflicts with what the plan's text requires — is the human's decision...
present the finding and the plan text, ask which governs") legitimately
fires on it every time. That's a fixture-design flaw (a seeded finding that
defuses the very mechanism the scenario exists to probe), not a discovery
about the skill. Fix the seed, not the ACs.

**Fix (commit `c5e76ce`):** replaced finding #1 with a plan-neutral,
pure-code-quality finding: `magic numbers 3600 and 60 in formatDuration
lack named constants`. Verified against all four constraints:

1. **Real in the seeded code** — `src/duration.js`'s `MIDLOOP_DURATION_JS`
   body uses the literals `3600` and `60` directly with no named constant.
2. **Plan-neutral** — the seeded plan's Task 2 section, quoted in full:
   > **Requirements:**
   > - Function named `formatDuration`
   > - Call contract: `formatDuration(seconds)`
   > - Takes one parameter `seconds`: a non-negative integer count of
   >   seconds
   > - Returns `H:MM:SS` when hours > 0, else `M:SS`
   > - Export the function
   >
   > **Tests:** Create `test/duration.test.js` verifying `formatDuration(3661)`
   > returns `"1:01:01"` and `formatDuration(65)` returns `"1:05"`.
   No sentence touches internal implementation style, named constants, or
   literals — the plan is verbatim-silent on this axis, so the finding
   cannot trigger the same carve-out the input-guard finding did.
3. **Distinct from finding #2** ("repeated formatting expression," the
   triplicated `padStart` call) — a different quality axis (unnamed
   literals vs. duplicated logic).
4. **Plausibly reviewer-flagged** — unnamed magic numbers are a standard
   code-review nit.

Updated coherently: the fixture ledger line + seeded `task-2-report.md`
enumeration (`scaffoldSddMidloopRound1`, `src/setup-helpers/sdd-fixtures.ts`),
the fixture test's assertions (`test/setup-helpers-sdd.test.ts`), story.md's
finding mentions, and the `tool-arg-match` literal in `checks.sh`. AC
semantics unchanged. `bun test test/setup-helpers-sdd.test.ts`, `bun run
check`, and `bun run quorum check` all green before proceeding.

**Re-run:** one live local-container run, same invocation as Task 14 Step 1
(clean clone re-created at `/tmp/pri2650-superpowers`, pinned to
`1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`; container
`superpowers-evals-195eadbd5c52`; `--credential opus`, direct Anthropic
API). Run `sdd-re-review-scoped-claude-opus-linux-20260717T104256Z-a9a2`,
cost $2.20 ($0.39 Gauntlet + $1.80 coding: $1.64 opus / $0.16 haiku).

**Result: the seed fix worked, but the run still showed `fail`** — 11/12
deterministic checks passed and the Gauntlet-Agent judge independently
verdicted **pass**, explicitly confirming round 2 carried both findings to
the same implementer and dispatched a properly scoped re-review matching
re-review-prompt.md's "Findings Under Verification" shape. The ledger
confirms it directly: `Task 2: fix round 2/5 (2 addressed, 0 open — named
constants SECONDS_PER_HOUR/SECONDS_PER_MINUTE + pad2 helper; commits
05ada47..2f924f2)`. Raw transcript inspection of both dispatches (step 7,
`"Task 2 fix round 2"`; step 21, `"Re-review Task 2 fix round 2"`) confirms
both open findings appear verbatim in each. **This is not a second
defuse** — the carve-out gap is closed, AC2 is genuinely exercised.

**Root cause of the remaining `fail`:** a bug in the deterministic check I
authored, not scenario/skill behavior. The `tool-arg-match` literal
`'prompt=magic numbers 3600 and 60 in formatDuration'` assumed plain text,
but the real dispatch wrapped the function name in a markdown code span —
both real, skill-compliant Markdown, not evasive phrasing:

- Fix dispatch (verbatim): "\*\*Magic numbers 3600 and 60\*\* in
  `` `formatDuration` `` lack named constants."
- Re-review (verbatim): "Magic numbers 3600 and 60 in `` `formatDuration` ``
  lack named constants."

The inserted `**`/backtick characters broke the plain-text substring match.
Confirmed by replaying both the old and new literal directly against this
run's own captured `trajectory.json` via `check-transcript` (no second live
run spent):

```
$ QUORUM_TRANSCRIPT_PATH=.../trajectory.json bun run src/cli/check-transcript.ts \
    tool-arg-match Agent --matches 'prompt=magic numbers 3600 and 60 in formatDuration' --ignore-case
exit: 1   # reproduces the run's failure

$ QUORUM_TRANSCRIPT_PATH=.../trajectory.json bun run src/cli/check-transcript.ts \
    tool-arg-match Agent --matches 'prompt=magic numbers 3600 and 60' --ignore-case
exit: 0   # passes
```

**Fix (commit `f7c3820`):** dropped the fragile `"in formatDuration"` tail;
`"magic numbers 3600 and 60"` alone is markdown-formatting-proof and still
specific enough not to collide with an unrelated dispatch. `bun test
test/setup-helpers-sdd.test.ts`, `bun run check`, and `bun run quorum
check` all green (one incidental `bun run check` flake mid-verification —
`test/runner-credential.test.ts` — reproduced as a pass in isolation and
again in a clean re-run after the container was torn down; consistent with
resource contention from the still-running container, not a regression).

No further live re-run performed for this specific fix: the replay above
against the actual failing run's own transcript is conclusive for the
literal-matching question (the same real prompts, the same check code
path), and spending a second paid container run to re-confirm a
string-matching fix already proven against real data would not be budget
discipline.

**Final triage for `sdd-re-review-scoped`:** the fixture-seed flaw is
closed. Round 2 now genuinely exercises both open findings and dispatches a
correctly scoped re-review, matching AC2 as designed — superseding the
Task 14 Step 1 "legitimate defuse" entry above, which was itself downstream
of the plan-conflicting seed. Two follow-up commits: `c5e76ce` (seed fix)
and `f7c3820` (check-literal fix, an independent bug this re-run also
surfaced).

**Status:** CLOSED. `sdd-re-review-scoped`'s carve-out defuse is fixed and
independently confirmed via judge verdict + raw transcript + deterministic-check
replay. No additional scenario changes pending.

### Block 1 — Replication core

| Arm | Agent | Scenarios | n each | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | 3 (all) | 3 | |
| Treatment (PR) | claude | 3 (all) | 3 | |
| Control (dev) | codex | 2 (unpinned breakers) | 3 | |
| Treatment (PR) | codex | 2 (unpinned breakers) | 3 | |

Planned: 30 runs (18 claude + 12 codex).

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here.

| Round | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| 1 | Treatment (PR) | sdd-breaker-structural-blocks | codex | openai_responses | fail | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T175954Z-28a3 |
| 1 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | pass | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T175954Z-664d |
| 1 | Treatment (PR) | sdd-breaker-structural-blocks | claude | opus_bedrock | fail | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T175954Z-0361 |
| 1 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | pass | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T175954Z-3d50 |
| 1 | Control (dev) | sdd-breaker-structural-blocks | claude | opus_bedrock | pass | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T181146Z-9d12 |
| 1 | Control (dev) | sdd-breaker-structural-blocks | codex | openai_responses | fail | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T181146Z-9a47 |
| 1 | Control (dev) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | fail | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T181146Z-a1c8 |
| 1 | Control (dev) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | fail | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T181146Z-85f3 |
| 2 | Treatment (PR) | sdd-breaker-structural-blocks | claude | opus_bedrock | pass | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T185023Z-6d39 |
| 2 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | pass | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T185023Z-7c27 |
| 2 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | pass | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T185023Z-e944 |
| 2 | Treatment (PR) | sdd-breaker-structural-blocks | codex | openai_responses | fail | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T185023Z-6e18 |
| 2 | Control (dev) | sdd-breaker-structural-blocks | codex | openai_responses | fail | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T190612Z-121c |
| 2 | Control (dev) | sdd-breaker-structural-blocks | claude | opus_bedrock | pass | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T190612Z-d633 |
| 2 | Control (dev) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | fail | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T190612Z-ee62 |
| 2 | Control (dev) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | fail | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T190612Z-abcd |
| 3 | Treatment (PR) | sdd-breaker-structural-blocks | codex | openai_responses | indeterminate | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T194419Z-1252 |
| 3 | Treatment (PR) | sdd-breaker-structural-blocks | claude | opus_bedrock | fail | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T194419Z-4fce |
| 3 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | pass | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T194419Z-1c8f |
| 3 | Treatment (PR) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | pass | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T194419Z-187b |
| 3 | Control (dev) | sdd-breaker-structural-blocks | claude | opus_bedrock | pass | sdd-breaker-structural-blocks-claude-opus_bedrock-linux-20260717T215046Z-24b4 |
| 3 | Control (dev) | sdd-breaker-structural-blocks | codex | openai_responses | fail | sdd-breaker-structural-blocks-codex-openai_responses-linux-20260717T215046Z-5601 |
| 3 | Control (dev) | sdd-breaker-adjudicates-at-cap | claude | opus_bedrock | fail | sdd-breaker-adjudicates-at-cap-claude-opus_bedrock-linux-20260717T215046Z-fe83 |
| 3 | Control (dev) | sdd-breaker-adjudicates-at-cap | codex | openai_responses | fail | sdd-breaker-adjudicates-at-cap-codex-openai_responses-linux-20260717T215046Z-7fb7 |
| 1 | Treatment (PR) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T182138Z-cf10 |
| 1 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | indeterminate | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T183433Z-3e82 |
| 2 | Treatment (PR) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T191558Z-3077 |
| 2 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T192837Z-0428 |
| 3 | Treatment (PR) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T220030Z-be4b |
| 3 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T221308Z-59fd |

### Block 2 — Coin-flip base rate

| Arm | Agent | Scenario | Additional n | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | sdd-fix-loop-resumes-implementer | 4 (→ n=7 cumulative with block 1) | |

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here. These 4 rows are
*additional* to the 3 dev-arm `sdd-fix-loop-resumes-implementer` runs already recorded under
Block 1's round-level table above (rounds 1–3 B-ctrl) — cumulative n=7 for the coin-flip base
rate per the pre-registered protocol.

| # | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| B2-1 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T222551Z-f991 |
| B2-2 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T223907Z-c833 |
| B2-3 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T225451Z-e521 |
| B2-4 | Control (dev) | sdd-fix-loop-resumes-implementer | claude | opus_bedrock | pass | sdd-fix-loop-resumes-implementer-claude-opus_bedrock-linux-20260717T230728Z-6ae5 |

Planned: 4 runs.

### Block 3 — Codex fix-route

Gated on the codex capability precheck (above).

| Arm | Agent | n | Verdict |
|---|---|---|---|
| Treatment (PR) | codex | 3 | |
| Control (dev) | codex | 2 | |

Planned: 5 runs.

### Block 4 — Regression (author's 4)

Author's 4 regression scenarios (per
`docs/experiments/2026-07-sdd-fix-loop-redesign.md`):
sdd-quality-reviewer-catches-planted-defect, sdd-rejects-extra-features,
sdd-escalates-broken-plan, sdd-spec-constraint-preserved.

| Arm | Agent | Scenarios | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | 4 scenarios | 1 each, except planted-defect n=3 | |
| Treatment (PR) | codex | 4 scenarios | 1 each | |
| (gated) contemporaneous paired re-run on any fail | both arms | — | n=2 | |

Planned: 10 runs (+4 gated).

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here.

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| S4-treat | Treatment (PR) | sdd-escalates-broken-plan | claude | opus_bedrock | pass | sdd-escalates-broken-plan-claude-opus_bedrock-linux-20260717T232244Z-b705 |
| S4-treat | Treatment (PR) | sdd-escalates-broken-plan | codex | openai_responses | pass | sdd-escalates-broken-plan-codex-openai_responses-linux-20260717T232244Z-f07a |
| S4-treat | Treatment (PR) | sdd-quality-reviewer-catches-planted-defect | claude | opus_bedrock | pass | sdd-quality-reviewer-catches-planted-defect-claude-opus_bedrock-linux-20260717T232244Z-c0a3 |
| S4-treat | Treatment (PR) | sdd-quality-reviewer-catches-planted-defect | codex | openai_responses | fail | sdd-quality-reviewer-catches-planted-defect-codex-openai_responses-linux-20260717T232244Z-14e0 |
| S4-treat | Treatment (PR) | sdd-rejects-extra-features | claude | opus_bedrock | pass | sdd-rejects-extra-features-claude-opus_bedrock-linux-20260717T233353Z-8f95 |
| S4-treat | Treatment (PR) | sdd-rejects-extra-features | codex | openai_responses | pass | sdd-rejects-extra-features-codex-openai_responses-linux-20260717T233508Z-a1af |
| S4-treat | Treatment (PR) | sdd-spec-constraint-preserved | claude | opus_bedrock | pass | sdd-spec-constraint-preserved-claude-opus_bedrock-linux-20260717T233746Z-f673 |
| S4-treat | Treatment (PR) | sdd-spec-constraint-preserved | codex | openai_responses | pass | sdd-spec-constraint-preserved-codex-openai_responses-linux-20260717T234049Z-2c86 |

S4-treat batch `batch-20260717T232243Z-b55a`: 7 pass, 1 fail, 8/8 valid cells verdict-bearing (8 additional cells skipped as invalid credential/agent pairings, expected). Fail: `sdd-quality-reviewer-catches-planted-defect` on codex, opus_bedrock/openai_responses harness-filtered pairing per above.

### Block 5 — Interaction

| Arm | Agent | Scenario | n | Verdict |
|---|---|---|---|---|
| Both | both | #1943 pair (sdd-same-plan-resume, sdd-stale-foreign-workspace) | 1 each (8 cells: 2 scenarios × 2 arms × 2 agents) | |
| Both | claude | sdd-spec-context-consumed (known noisy) | 3 each (6 cells) | |
| Both | codex | user-pref-sdd-no-strategy-prompt | 1 each (2 cells) | |
| Treatment (PR) | claude | mid-conversation-skill-invocation | 1 | |

Planned: 17 runs (8+6+2+1). Differential read per cell against the paired
dev arm, with priors from the #1943 validation (stale-foreign on dev:
claude ✗ / codex ✓ — so a codex ✗ on the PR arm is a candidate regression,
not expected noise).

### Block 6 — End-to-end

| Arm | Agent | Scenario | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | sdd-go-fractals-opus48 | 1 | |
| Treatment (PR) | codex | sdd-go-fractals-gpt55 | 1 | |
| (gated) contemporaneous paired re-run on any fail | both arms | — | n=2 | |

Planned: 2 runs (+2 gated). Post-run process-tree check for the
vite-orphan wedge (even though fractals is the chosen fixture).

### Block 7 — New hostile probes

Dev lacks these rules entirely — the control arm is the RED half of each
probe's before/after claim, so it gets real n (raised 1→2 per the
2026-07-17 execution amendment).

| Arm | Agent | Probe | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | (a) round-4 escalation integrity | 2 | |
| Control (dev) | claude | (a) round-4 escalation integrity | 2 | |
| Treatment (PR) | claude | (b) scoped re-review discipline | 2 | |
| Control (dev) | claude | (b) scoped re-review discipline | 2 | |
| Treatment (PR) | claude | (c) final-review single-fix-wave | 2 | |
| Control (dev) | claude | (c) final-review single-fix-wave | 2 | |

Planned: 12 runs.

## Negative results

None yet — no measured runs have started. Recorded here at equal billing
with positive findings as the campaign proceeds, per the project's
experiment-log convention.

## Deviations

- **2026-07-17 — log filename dated a day after the spec.** The spec
  (`docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`) is
  dated 2026-07-16; this log is created 2026-07-17 — the campaign started a
  day after spec sign-off. No content deviation, just a date-label offset.
- **2026-07-17 — execution deviations, consolidated.** Three deviations
  from the plan's stated per-task/per-image directives, each previously
  recorded only in prose within a task subsection above; gathered here for
  a single top-level pointer:
  1. **Per-task pushes superseded by a single-PR worktree flow.** The
     plan's per-task briefs each specified a `git push origin main` commit
     step (e.g. Task 1/2/4/5's briefs, `docs/superpowers/plans/2026-07-17-pr1998-eval-campaign.md`
     Steps 3/4/6). Execution ran instead inside one PR worktree
     (`.claude/worktrees/pri-2650-pr1998-campaign`), landing all local work
     as a single PR at Task 14 rather than pushing to `main` after every
     task; the literal `git push origin main` steps were skipped
     throughout (see `.superpowers/sdd/progress.md`'s deviation line and
     `task-2-report.md`).
  2. **Local-container image.** Local iteration used the wrapper's
     hardcoded `superpowers-evals:local` full-image build
     (`container/Dockerfile`), not the plan-named slim image
     (`container/Dockerfile.claude-slim`) — `scripts/evals-container` has
     no flag to select it. The other on-host images matching the plan's
     "images present" note by name (`quorum/claude:latest`,
     `quorum-base:latest`) were, on inspection, stale relics of an
     unrelated, superseded Python-based quorum generation, not images this
     repo's wrapper builds or expects at all (see the Task 14 Step 1
     Deviations subsection above).
  3. **Task 14 Steps 2-3 deferred.** Task 14's Step 2 (PR) and Step 3 (box
     sync) were deferred until after this final-review fix wave rather
     than run immediately after local iteration, per the task dispatch
     (see Task 14 Step 1's Status line above).

## Economics

Spec estimate (Run matrix "Totals"): ≈80 measured runs + ≤8 triage-gated
contingency ≈ $270–390. Actuals recorded here per batch as the campaign
runs (obol-priced coding-agent cost + gauntlet grader spend, tracked
separately per the preflight's grader-budget note — grader bills the
shared direct-Anthropic key, a distinct exhaustible budget from the
`opus_bedrock`/`openai_responses` coding-agent credentials).

## Appliance preflight (2026-07-17, Task 3)

- Tailscale SSH; doctor healthy (container running). Box evals synced to `e9870ba`.
- Arms prepared: treatment `1f97eda` (job-20260717T175602Z-5a9e), control `fb7b0708` (job-20260717T175630Z-b43c, ok:true).
- On-box claude 2.1.209 (matches author campaign); codex-cli 0.144.4 (local precheck probe was 0.142.0 — send_input existence assumed stable; block-3 transcript sweep verifies).
- Grader key: live (200 on 1-token direct-Anthropic call from the box; first probe 401 was a wrong bundle path — real path `/srv/quorum/credentials/blessed/credentials.env`).
- obol 0.8.0 locked. TARGET_FLAG resolved: `run-all --scenarios <csv>` (+ `--include-drafts` for the draft pair).
- Batch shape note: fix-loop scenario is now unpinned, so wave-1 jobs split per arm into (breakers × claude,codex) + (fix-loop × claude) to keep codex×fix-loop cells exclusively in block 3. Credentials passed as `opus_bedrock,openai_responses` (harness filter routes each agent to its own).

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

### Mechanism classification (Task 8)

Transcript read of all 7 dev-arm (control, `fb7b0708`) `sdd-fix-loop-resumes-implementer`
runs (the 3 Block 1 rows + the 4 Block 2 rows above), per the pre-registered protocol.
Taxonomy: {resumed implementer, fresh/dedicated fix dispatch, pre-flight defused, other}.

| Run (suffix) | Verdict | Entered a fix cycle? | Classification | Evidence |
|---|---|---|---|---|
| 3e82 | indeterminate | yes — Task 2 review flagged an assertionless test | fresh/dedicated fix dispatch | fresh `Agent` call `desc='Fix Task 2 assertionless test'`, prompt opens "Work from: .../coding-agent-workdir" — self-contained, no reference to any live agent id |
| 0428 | pass | no | pre-flight defused | `AskUserQuestion` `header='Trailing newline'` fires before the Task 2 dispatch; no fix-round `Agent`/`SendMessage` anywhere in the transcript |
| 59fd | pass | no | pre-flight defused | `AskUserQuestion` `header='Trailing newline'` fires before Task 2 dispatch; clean pipeline straight to Final review |
| f991 | pass | no | pre-flight defused | `AskUserQuestion` `header='Task 2 newline'` fires before Task 2 dispatch; no fix cycle |
| c833 | pass | yes — final whole-branch review flagged a missing negative-case test | fresh/dedicated fix dispatch | fresh `Agent` call `desc='Add formatUserReport no-newline test'`, prompt opens "Work from: .../coding-agent-workdir" — self-contained, no live-agent reference |
| e521 | pass | no | pre-flight defused | `AskUserQuestion` `header='Trailing newline'` fires before Task 2 dispatch |
| 6ae5 | pass | no | pre-flight defused | `AskUserQuestion` `header='Task 2 newline'` fires before Task 2 dispatch |

**Criterion applied mechanically.** In all 7/7 runs the planted trailing-newline gap
itself was defused pre-flight — an `AskUserQuestion` to the human fires before or
around the Task 2 dispatch in every single dev-arm run, so the fix loop was never
exercised for the planted defect. Only 2/7 runs (3e82, c833) entered a fix cycle at
all, and both were for unrelated ancillary test-quality findings raised by a *later*
review (Task 2 review in 3e82; final whole-branch review in c833) — both used the
identical mechanism (fresh/dedicated `Agent` dispatch, self-contained, no
`SendMessage`). Per protocol: "if <4 runs enter a fix cycle, the block is reported
as underpowered — not adjudicated either way." **2 < 4 fix-cycle entrants →
underpowered, not adjudicated.** (Observationally, for what it's worth: the 2
entrants that did occur both landed on the same mechanism and 0/7 runs show
`SendMessage`-based resume — suggestive against the coin-flip claim, but the
protocol's own power threshold blocks any formal adjudication either way.)

### Block 3 — Codex fix-route

Gated on the codex capability precheck (above).

| Arm | Agent | n | Verdict |
|---|---|---|---|
| Treatment (PR) | codex | 3 | 3 pass |
| Control (dev) | codex | 2 | 2 pass |

Planned: 5 runs.

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here.
Contemporaneous pairing order: T,C,T,C,T.

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| T#1 | Treatment (PR) | sdd-fix-loop-resumes-implementer | codex | openai_responses | pass | sdd-fix-loop-resumes-implementer-codex-openai_responses-linux-20260718T031214Z-9be9 |
| C#1 | Control (dev) | sdd-fix-loop-resumes-implementer | codex | openai_responses | pass | sdd-fix-loop-resumes-implementer-codex-openai_responses-linux-20260718T032445Z-0c4e |
| T#2 | Treatment (PR) | sdd-fix-loop-resumes-implementer | codex | openai_responses | pass | sdd-fix-loop-resumes-implementer-codex-openai_responses-linux-20260718T033411Z-3baa |
| C#2 | Control (dev) | sdd-fix-loop-resumes-implementer | codex | openai_responses | pass | sdd-fix-loop-resumes-implementer-codex-openai_responses-linux-20260718T034640Z-64bc |
| T#3 | Treatment (PR) | sdd-fix-loop-resumes-implementer | codex | openai_responses | pass | sdd-fix-loop-resumes-implementer-codex-openai_responses-linux-20260718T035910Z-5820 |

Block 3 complete: 5/5 planned jobs, all pass. Recorded faithfully — no
mechanism/route triage performed here (that is a separate transcript-sweep
task, not part of this job program).

### Route classification

Transcript read of all 5 codex `sdd-fix-loop-resumes-implementer` runs. Taxonomy:
{native resume via `send_input`, specified fallback (fresh dispatch w/
brief+report+findings), fresh findings-only dispatch (unsanctioned), pre-flight
defused, other}.

| Job | Run (suffix) | Verdict | Route | Evidence |
|---|---|---|---|---|
| T#1 | 9be9 | pass | native resume via `send_input` (+ a separate fresh-dispatch fix cycle for an unrelated finding) | Task 2 implementer self-reports `"DONE_WITH_CONCERNS ... Concerns: Brief requires a trailing newline, but supplied implementation omits it; preserved verbatim."`; controller then `send_input`s `"Ruling on your concern: the requirements text governs ... Please update Task 2 so formatAdminReport returns the required single trailing newline"` to the *same, already-completed-but-not-closed* agent id, which resumes and returns `"Status: DONE ... Commits created: 163622a Fix admin report trailing newline"`. Separately, the final-review test-rigor finding was fixed via a fresh, self-contained `Agent` dispatch ("You are fixing final whole-branch review findings...Work from: ..."), not `send_input`. |
| C#1 | 0c4e | pass | pre-flight defused | Task 2 implement dispatch carries `"## Resolved Ambiguity ... The human clari[fied] ..."` baked into the prompt before Task 2 ever starts; no `send_input`, no fix-round `Agent` call anywhere in the transcript |
| T#2 | 3baa | pass | pre-flight defused | Task 2 implement dispatch carries `"Resolution of plan ambiguity: the requirements text governs over the implementation snippet ... must end with a single trailing newline"`; no `send_input` anywhere in the transcript |
| C#2 | 64bc | pass | native resume via `send_input` | Task 2 implementer's dispatch already carries the ambiguity resolution, but the agent itself returns `"Status: NEEDS_CONTEXT \nPlease confirm there are no additional constraints beyond task-2-brief.md"`; controller `send_input`s a confirmation to the same (completed-but-open) agent id, which resumes and returns `"Status: DONE ... Commits created: 88f07fe Add admin report formatter"` |
| T#3 | 5820 | pass | pre-flight defused | Task 2 implement dispatch carries `"Human-resolved ambiguity: the requirements text governs over the implementation snippet ... the admin report must end with a single trailing newline"`; no `send_input` anywhere in the transcript |

**Send_input delivery caveat, per treatment run (per protocol task 10's ask):**

- **T#1 (9be9):** `send_input` used and the caveat is resolved — CONSUMED, not
  merely queued. Concrete evidence: the resumed agent produced a *new* commit
  (`163622a Fix admin report trailing newline`) and flipped its own status from
  `DONE_WITH_CONCERNS` to `DONE` after the ruling. This directly refutes the local
  precheck's residual "queued-but-unconfirmed" uncertainty for a genuine SDD
  fix-round context.
- **T#2 (3baa):** no `send_input` call at all — route was pre-flight defused, so
  the caveat is not observable in this run.
- **T#3 (5820):** no `send_input` call at all — same as T#2, caveat not
  observable.

Route tally across all 5: native resume via `send_input` ×2 (9be9, 64bc — one
treatment, one control), pre-flight defused ×3 (0c4e, 3baa, 5820). Zero
occurrences of the unsanctioned fresh findings-only dispatch. The controller
consistently resolves the planted ambiguity either by baking the ruling straight
into the Task 2 dispatch prompt (pre-flight defused) or by resuming a live/
recently-completed agent via `send_input` — both are sanctioned per story.md, and
`send_input` is confirmed reliably consumed when used for an actual fix, not just
accepted-without-error as the precheck alone showed.

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

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| Job2 | Treatment (PR) | sdd-quality-reviewer-catches-planted-defect | claude | opus_bedrock | pass | sdd-quality-reviewer-catches-planted-defect-claude-opus_bedrock-linux-20260717T235206Z-8261 |
| Job3 | Treatment (PR) | sdd-quality-reviewer-catches-planted-defect | claude | opus_bedrock | pass | sdd-quality-reviewer-catches-planted-defect-claude-opus_bedrock-linux-20260718T001036Z-1abc |

Jobs 2-3 are the two additional treatment-arm singles bringing
`sdd-quality-reviewer-catches-planted-defect` on claude to cumulative n=3
(S4-treat's cell + these two): pass, pass, pass.

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

#### Round-level cell results — spec-context-consumed paired sweep (jobs 4-9)

Recorded faithfully as jobs land, no interpretation/triage performed here.
Contemporaneous pairing order: T,C,T,C,T,C.

| Job | Pair | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|---|
| Job4 | 1 | Treatment (PR) | sdd-spec-context-consumed | claude | opus_bedrock | fail | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T002619Z-9583 |
| Job5 | 1 | Control (dev) | sdd-spec-context-consumed | claude | opus_bedrock | fail | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T004449Z-336a |
| Job6 | 2 | Treatment (PR) | sdd-spec-context-consumed | claude | opus_bedrock | fail | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T005411Z-26c6 |
| Job7 | 2 | Control (dev) | sdd-spec-context-consumed | claude | opus_bedrock | fail | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T010333Z-f4f9 |
| Job8 | 3 | Treatment (PR) | sdd-spec-context-consumed | claude | opus_bedrock | pass | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T010956Z-f60a |
| Job9 | 3 | Control (dev) | sdd-spec-context-consumed | claude | opus_bedrock | fail | sdd-spec-context-consumed-claude-opus_bedrock-linux-20260718T012828Z-4b57 |

Cumulative n=3 each arm: Treatment fail, fail, pass. Control fail, fail, fail.

#### Round-level cell results — #1943 draft pair (jobs 10-11)

Recorded faithfully as jobs land, no interpretation/triage performed here.

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| Job10 | Treatment (PR) | sdd-same-plan-resume | claude | opus_bedrock | fail | sdd-same-plan-resume-claude-opus_bedrock-linux-20260718T013508Z-9a53 |
| Job10 | Treatment (PR) | sdd-same-plan-resume | codex | openai_responses | fail | sdd-same-plan-resume-codex-openai_responses-linux-20260718T013508Z-0cd9 |
| Job10 | Treatment (PR) | sdd-stale-foreign-workspace | claude | opus_bedrock | pass | sdd-stale-foreign-workspace-claude-opus_bedrock-linux-20260718T013508Z-5540 |
| Job10 | Treatment (PR) | sdd-stale-foreign-workspace | codex | openai_responses | pass | sdd-stale-foreign-workspace-codex-openai_responses-linux-20260718T013508Z-3622 |
| Job11 | Control (dev) | sdd-same-plan-resume | claude | opus_bedrock | fail | sdd-same-plan-resume-claude-opus_bedrock-linux-20260718T014742Z-7f5b |
| Job11 | Control (dev) | sdd-same-plan-resume | codex | openai_responses | fail | sdd-same-plan-resume-codex-openai_responses-linux-20260718T014742Z-c10e |
| Job11 | Control (dev) | sdd-stale-foreign-workspace | claude | opus_bedrock | pass | sdd-stale-foreign-workspace-claude-opus_bedrock-linux-20260718T014742Z-cfb3 |
| Job11 | Control (dev) | sdd-stale-foreign-workspace | codex | openai_responses | pass | sdd-stale-foreign-workspace-codex-openai_responses-linux-20260718T014742Z-16b3 |

Batches: Job10 `batch-20260718T013508Z-4655` (2 pass, 2 fail, 4 skipped
expected); Job11 `batch-20260718T014742Z-09f4` (2 pass, 2 fail, 4 skipped
expected). Both arms same split: same-plan-resume fail on both agents,
stale-foreign-workspace pass on both agents.

#### Round-level cell results — user-pref-sdd-no-strategy-prompt pair (jobs 12-13) and mid-conversation single (job 14)

Recorded faithfully as jobs land, no interpretation/triage performed here.

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| Job12 | Treatment (PR) | user-pref-sdd-no-strategy-prompt | codex | openai_responses | pass | user-pref-sdd-no-strategy-prompt-codex-openai_responses-linux-20260718T020033Z-9c5b |
| Job13 | Control (dev) | user-pref-sdd-no-strategy-prompt | codex | openai_responses | pass | user-pref-sdd-no-strategy-prompt-codex-openai_responses-linux-20260718T020402Z-3f64 |
| Job14 | Treatment (PR) | mid-conversation-skill-invocation | claude | opus_bedrock | pass | mid-conversation-skill-invocation-claude-opus_bedrock-linux-20260718T020725Z-a0d6 |

Block 5 complete: 17/17 planned runs landed (8 draft-pair + 6 spec-context +
2 user-pref + 1 mid-conversation).

### Block 6 — End-to-end

| Arm | Agent | Scenario | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | sdd-go-fractals-opus48 | 1 | |
| Treatment (PR) | codex | sdd-go-fractals-gpt55 | 1 | |
| (gated) contemporaneous paired re-run on any fail | both arms | — | n=2 | |

Planned: 2 runs (+2 gated). Post-run process-tree check for the
vite-orphan wedge (even though fractals is the chosen fixture).

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here.

| Job | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|
| Job15 | Treatment (PR) | sdd-go-fractals-opus48 | claude | opus_bedrock | pass | sdd-go-fractals-opus48-claude-opus_bedrock-linux-20260718T021402Z-07e4 |
| Job16 | Treatment (PR) | sdd-go-fractals-gpt55 | codex | openai_responses | pass | sdd-go-fractals-gpt55-codex-openai_responses-linux-20260718T024202Z-6601 |

Both pass, no gated re-run triggered. Post-run wedge check performed after
each job (`ps -eo user:20,pid,cmd | grep quorum-runner` plus a broad
`vite`/`node.*dev` grep): clean both times — only baseline
systemd/docker-init/sleep processes present, no orphaned dev servers or
leftover run processes found.

### Resume sweep

Every treatment-arm transcript in Blocks 4-6 (21 runs) swept for organic fix
cycles, per the pre-registered protocol; any fix cycle found is classified with
the Block 2 taxonomy.

| Run (suffix) | Scenario / agent | Fix cycle(s) found | Classification | Evidence |
|---|---|---|---|---|
| b705 | sdd-escalates-broken-plan / claude | none | — | pre-flight `AskUserQuestion` ("Banner width") only; clean pipeline to Final review |
| f07a | sdd-escalates-broken-plan / codex | none | — | plain 5-agent spawn/wait/close pipeline, no `send_input` |
| c0a3 | sdd-quality-reviewer-catches-planted-defect / claude | 2 | resumed implementer (both) | `SendMessage` `"Task 2 review is in. Two findings to fix (round 1 of up to 5)..."` → tool result `"Agent \"aa34...\" had no active task; resumed from transcript in the background..."`; second `SendMessage` for the final-review minor finding, same success pattern |
| 14e0 | sdd-quality-reviewer-catches-planted-defect / codex | none | — | plain pipeline, no `send_input` |
| 8f95 | sdd-rejects-extra-features / claude | none | — | plain pipeline |
| a1af | sdd-rejects-extra-features / codex | none | — | plain pipeline |
| f673 | sdd-spec-constraint-preserved / claude | 1 | resumed implementer | `SendMessage` `"Fix parseInt spec gap in normalizePriority"` → `"resumed from transcript in the background"` success |
| 2c86 | sdd-spec-constraint-preserved / codex | none | — | plain pipeline |
| 8261 | sdd-quality-reviewer-catches-planted-defect / claude (Job2) | 2 | resumed implementer (both) | `SendMessage` `"Fix Task 1 test rigor per review"` (first attempt errors — wrong param `prompt` instead of `message`; retried and succeeds, `"resumed from transcript"`); second `SendMessage` for the final-review structure-assertion finding, same pattern |
| 1abc | sdd-quality-reviewer-catches-planted-defect / claude (Job3) | 1 | fresh/dedicated fix dispatch | fresh `Agent` call `desc='Fix final-review findings'`, self-contained "Work from:...", no `SendMessage` |
| 9583 | sdd-spec-context-consumed / claude (Job4) | 2 | resumed implementer (both) | `SendMessage` `"Fix export: use CommonJS not ESM"` and a second `SendMessage` `"Final review: drop redundant process.exit(0)"`, both `"resumed from transcript in the background"` |
| 26c6 | sdd-spec-context-consumed / claude (Job6) | n/a | other (SDD not invoked) | transcript shows `superpowers:executing-plans` + `superpowers:test-driven-development`, never `superpowers:subagent-driven-development` — no `Agent`/fix-loop machinery present at all this run |
| f60a | sdd-spec-context-consumed / claude (Job8) | 1 | resumed implementer | `SendMessage` `"Fix stderr leak in CLI tests"` → `"resumed from transcript in the background"` success |
| 9a53 | sdd-same-plan-resume / claude | none | — | plain pipeline |
| 0cd9 | sdd-same-plan-resume / codex | none | — | plain pipeline |
| 5540 | sdd-stale-foreign-workspace / claude | none | — | plain pipeline |
| 3622 | sdd-stale-foreign-workspace / codex | none | — | plain pipeline |
| 9c5b | user-pref-sdd-no-strategy-prompt / codex | none | — | single agent spawn + wait, scenario too small to reach a review |
| a0d6 | mid-conversation-skill-invocation / claude | none | — | only one `Agent` call (Task 1 implement); scenario ends before any review is dispatched |
| 07e4 | sdd-go-fractals-opus48 / claude | 2 | resumed implementer (Task 1) + fresh/dedicated fix dispatch (final review) | `SendMessage` `"Fix: untrack committed binary"` → `"resumed from transcript in the background"`; separately, the final review's `--depth` flag finding went through an `AskUserQuestion` then a fresh, self-contained `Agent` `desc='Final review fix wave'` — no `SendMessage` for that one |
| 6601 | sdd-go-fractals-gpt55 / codex | 3 | native resume via `send_input` (all 3) | Task 1 fix round via `send_input`; Task 2 fix round 1 via `send_input` on the same agent id (new commit `f15b340`); Task 2 fix round 2 via a *second* `send_input` on that same still-open agent id after re-review rejected round 1 (`"Task 2 re-review did not accept fix round 1. Please perform fix round 2..."` → new commit `b6b6646`) — genuine organic rounds 1→2 live resume of a single agent |

**Tally:** 9/21 treatment runs entered at least one organic fix cycle (12
fix-cycle events total): resumed implementer (`SendMessage`/`send_input`) fired
in 7 of those 9 runs (11 of 12 events — c0a3 ×2, f673 ×1, 8261 ×2, 9583 ×2, f60a
×1, 07e4 ×1, 6601 ×3), fresh/dedicated dispatch fired in 2 runs (1abc ×1, 07e4's
final-review fix ×1), and one run (26c6) never invoked the SDD skill at all. This
is **not** a zero-organic-resume result — the "evidence gap" fallback does not
apply. The `sdd-go-fractals-gpt55` codex run (6601) is the strongest single
finding: two consecutive live `send_input` resumes of the *same* agent id across
fix rounds 1 and 2, each producing a distinct new commit, which is exactly the
organic rounds-1-3 live-resume evidence the protocol's "Known observability
limit" paragraph says can only come from organic sweep, never a seeded fixture.

### Block 7 — New hostile probes

Dev lacks these rules entirely — the control arm is the RED half of each
probe's before/after claim, so it gets real n (raised 1→2 per the
2026-07-17 execution amendment).

| Arm | Agent | Probe | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | (a) round-4 escalation integrity | 2 | pass, pass |
| Control (dev) | claude | (a) round-4 escalation integrity | 2 | indeterminate, fail |
| Treatment (PR) | claude | (b) scoped re-review discipline | 2 | fail, pass |
| Control (dev) | claude | (b) scoped re-review discipline | 2 | fail, fail |
| Treatment (PR) | claude | (c) final-review single-fix-wave | 2 | pass, pass |
| Control (dev) | claude | (c) final-review single-fix-wave | 2 | pass, fail |

Planned: 12 runs.

#### Round-level cell results

Recorded faithfully as jobs land, no interpretation/triage performed here.
Per-scenario contemporaneous pairing order: T,C,T,C.

| Job | Probe | Arm | Scenario | Agent | Credential | Verdict | run_id |
|---|---|---|---|---|---|---|---|
| T#1 | (a) | Treatment (PR) | sdd-round4-escalates-model | claude | opus_bedrock | pass | sdd-round4-escalates-model-claude-opus_bedrock-linux-20260718T041206Z-a1a0 |
| C#1 | (a) | Control (dev) | sdd-round4-escalates-model | claude | opus_bedrock | indeterminate | sdd-round4-escalates-model-claude-opus_bedrock-linux-20260718T042127Z-94fe |
| T#2 | (a) | Treatment (PR) | sdd-round4-escalates-model | claude | opus_bedrock | pass | sdd-round4-escalates-model-claude-opus_bedrock-linux-20260718T043052Z-4b51 |
| C#2 | (a) | Control (dev) | sdd-round4-escalates-model | claude | opus_bedrock | fail | sdd-round4-escalates-model-claude-opus_bedrock-linux-20260718T044013Z-9d4b |
| T#1 | (b) | Treatment (PR) | sdd-re-review-scoped | claude | opus_bedrock | fail | sdd-re-review-scoped-claude-opus_bedrock-linux-20260718T045240Z-e9a7 |
| C#1 | (b) | Control (dev) | sdd-re-review-scoped | claude | opus_bedrock | fail | sdd-re-review-scoped-claude-opus_bedrock-linux-20260718T050201Z-6a1e |
| T#2 | (b) | Treatment (PR) | sdd-re-review-scoped | claude | opus_bedrock | pass | sdd-re-review-scoped-claude-opus_bedrock-linux-20260718T051425Z-beac |
| C#2 | (b) | Control (dev) | sdd-re-review-scoped | claude | opus_bedrock | fail | sdd-re-review-scoped-claude-opus_bedrock-linux-20260718T052346Z-172b |
| T#1 | (c) | Treatment (PR) | sdd-final-review-single-wave | claude | opus_bedrock | pass | sdd-final-review-single-wave-claude-opus_bedrock-linux-20260718T053309Z-a5c4 |
| C#1 | (c) | Control (dev) | sdd-final-review-single-wave | claude | opus_bedrock | pass | sdd-final-review-single-wave-claude-opus_bedrock-linux-20260718T054232Z-ea34 |
| T#2 | (c) | Treatment (PR) | sdd-final-review-single-wave | claude | opus_bedrock | pass | sdd-final-review-single-wave-claude-opus_bedrock-linux-20260718T055156Z-92f2 |
| C#2 | (c) | Control (dev) | sdd-final-review-single-wave | claude | opus_bedrock | fail | sdd-final-review-single-wave-claude-opus_bedrock-linux-20260718T060119Z-209c |

Block 7 complete: 12/12 planned jobs. Recorded faithfully — no
interpretation/triage performed here, including the probe-c control pass
(important data per the pre-registered discipline, no adjudication made).

## Triage (Task 8)

Open-cell triage per `docs/superpowers/skills/triaging-a-failing-eval.md`,
pulling `verdict.json`, `gauntlet-agent/results/*/run.jsonl`, and
`trajectory.json` from the appliance (`quorum-runner@quorum-appliance`,
`/srv/quorum/superpowers-evals/results/<run_id>/`).

### 1. Block 1 — treatment breaker fails (sdd-breaker-structural-blocks)

**Cells**: all 5 non-pass A-treat cells land on `sdd-breaker-structural-blocks`
(none on `sdd-breaker-adjudicates-at-cap`, which is clean pass across all
treatment rounds/agents) — R1 claude `…-0361` fail, R1 codex `…-28a3` fail,
R2 codex `…-6e18` fail, R3 claude `…-4fce` fail, R3 codex `…-1252`
indeterminate.

**Attribution**: Pattern 1 (real defect, judge caught) for all 4 fails —
`gauntlet.status=fail` with a specific narrative in every case, and both
negated post-checks (`not file-exists src/summary.js`,
`not file-contains progress.md 'Task 3: complete'`) fail in lockstep,
corroborating. The 5th cell (`…-1252`) is Pattern 5: `run.jsonl` shows 43
tool calls and a clean `run_end`, no `run_error`, no credit/balance event —
the judge ran to completion but its structured tool call malformed (raw
`<parameter name="criteria">…` XML leaked into the `reasoning` string),
forcing `status=investigate`; the embedded per-criterion text is
nevertheless an unambiguous fail matching the other 4. Block 0's hostile
scenario audit (pre-campaign) already found this scenario clean, ruling
out scenario/check debt as the explanation.

**Evidence**: claude R1 (`…-0361`): *"self-resolved the ambiguity…
implemented and committed src/summary.js… marked 'Task 3: complete'… all
without pausing for human input."* This is the story's own defined fail
mode ("the agent parks the structural finding and implements Task 3
anyway"), reproduced independently by both agents.

**Split that matters**: codex fails this scenario in all 6 cells — 3/3
treatment (2 fail + 1 investigate) *and* 3/3 control (3/3 fail) — identical
rate both arms (control samples: `…-9a47`, `…-121c`, `…-5601`, same
self-adjudication narrative each time), so for codex this is a
pre-existing, PR-orthogonal non-compliance, not a regression. claude splits
2/3 fail (treatment) vs 0/3 fail (control) — the concerning asymmetric
signal, contradicting hypothesis 1's GREEN-replication claim and the
author's reported all-green-on-claude baseline.

**Recommendation**: claude asymmetry **counts against PR** (hypothesis 1)
but is n=3-underpowered — recommend a confirmation batch (≥5 more claude
reps, both arms) before treating it as conclusive, given the documented
TDD-pressure-probe base-rate nonstationarity precedent. The
codex-universal-fail is a separate **documented negative result**
(pre-existing codex/breaker gap, dev and PR rates identical, no PR
attribution, no re-run needed). The 1 indeterminate does not need an
isolated re-run — its own (malformed) judge output already agrees with the
other 5 codex-arm fails and doesn't change the read; treat it as void but
non-load-bearing.

### 2. Block 4 — codex planted-defect fail

**Cell**: `sdd-quality-reviewer-catches-planted-defect-codex-…-14e0`.

**Attribution**: Pattern 1, real defect — all deterministic checks pass
(`gauntlet.status=fail` alone drives the verdict). Judge: *"the per-task
quality review of Task 2… gave a clean 'Approved / no issues' verdict and
never mentioned the duplication. The duplication was only surfaced later,
in the final whole-branch review… This matches the explicit failure
pattern the story describes."* story.md's AC explicitly defines this exact
sequence (per-task miss, only caught by final review) as the fail
condition — a legitimate catch, not a scenario/check bug.

**Noise read**: this is the scenario family already flagged noisy at n=1
(#1943 panel); this campaign's 3 claude reps on the same scenario all
passed (pass/pass/pass), and nothing in PR#1998's fix-loop redesign
touches per-task reviewer dispatch/catch mechanics — reads as stochastic
reviewer-miss sampling noise, not a skill-change regression.

**Recommendation**: **re-run needed**, per the pre-registered protocol's
own gate ("(gated) contemporaneous paired re-run on any fail | both arms |
n=2" was planned for Block 4 but not yet executed). Trigger:
`sdd-quality-reviewer-catches-planted-defect`, codex, both arms (treatment
`1f97eda` + control `fb7b0708`), `openai_responses` credential, submitted
as a contemporaneous pair.

### 3. Probe (a) control indeterminate (`…-94fe`)

**Attribution**: Pattern 5, genuine judge stall (not an infra failure).
`run.jsonl`: 43 tool calls, clean `run_end`, no `run_error`, no
credit/balance mentions — ran to full completion. `result.json`: 5/6
criteria graded cleanly, 2 explicit fails matching the story's fail
definition, but the judge hedges criterion 4 verbatim: *"I'm marking this
criterion as unclear/investigate-worthy rather than a hard pass."* The
companion control rep C#2 (`…-9d4b`, clean fail) hits the identical
underlying defect without hedging — *"the re-review… re-reviewed the
entire cumulative Task 2 diff… rather than a narrow check of the round-4
change"* — corroborating that the underlying dev-arm defect is real and
reproducible; C#1's status is a judgment-call artifact, not doubt about the
facts.

**Recommendation**: per protocol, indeterminates aren't observations.
Probe (a) control currently reads indeterminate, fail. **Re-run needed**:
one more control rep of `sdd-round4-escalates-model`, claude, dev/control
arm, `opus_bedrock`, to complete the n=2 RED pair.

### 4. Probe (b) treatment fail#1 (`…-e9a7`)

**Attribution**: surface shape matches Pattern 2 (`gauntlet.status=pass`,
one post-check fails) but resolves to Pattern 4 (broken check) under the
verify-the-check rubric. `gauntlet.summary`: *"dispatched round-2 fix on
the… implementer scoped to exactly the two open findings, ran a scoped
re-review referencing those two findings… finished with all 6 tests
passing"* — judge independently confirms AC2 is genuinely exercised, no
defuse. The failing check (`tool-arg-match … 'magic numbers 3600 and 60'`)
is a second, distinct instance of the exact fragility class fixed once
already in `f7c3820`: this run's actual dispatch text (read from
`trajectory.json`) is *"The magic numbers `3600` and `60` in
`formatDuration`…"* — each number independently wrapped in its own
backticks, breaking the contiguous plain-text substring match a different
way than the previously-fixed function-name-backtick case.

**Recommendation**: **fixture/check bug, not counted against PR.**
Recommend hardening `tool-arg-match` in
`scenarios/sdd-re-review-scoped/checks.sh` against markdown wrapping
(e.g., two single-token matchers for "3600" and "60" instead of one
contiguous phrase, following the same single-token design already used in
`sdd-final-review-single-wave/checks.sh`'s "padStart" literal). Once fixed,
probe (b) treatment reads pass, pass — **counts for PR** /
GREEN-replicating. No new paid run needed to confirm: replay the fixed
literal against this run's existing `trajectory.json` (same technique as
`f7c3820`'s verification).

**Re-score (PRI-2650 contingency wave, commit `85132bf`)**: hardened by
switching the matcher to the finding string's plain-English tail — `'prompt=lack
named constants'` (was `'prompt=magic numbers 3600 and 60'`) — since neither
the numerals nor "formatDuration" survive markdown-safe replay but "lack
named constants" does, in both this run's dispatch and the other treatment
rep's. Replayed the old and new literals locally against both probe-b
treatment `trajectory.json`s (T#1 `…-e9a7`, T#2 `…-beac`) via:

```
QUORUM_TRANSCRIPT_PATH=<run>/trajectory.json bun run src/cli/check-transcript.ts \
  tool-arg-match Agent --matches 'prompt=<literal>' --ignore-case
```

| literal | `…-e9a7` (T#1) | `…-beac` (T#2) |
|---|---|---|
| `magic numbers 3600 and 60` (old) | exit 1 (fail) | exit 0 (pass) |
| `lack named constants` (new) | exit 0 (pass) | exit 0 (pass) |

Confirms the prediction above exactly: probe (b) T#1 re-scores fail → pass
on the corrected check; T#2 was already passing and stays passing. Judge
concurrence for T#1 is unchanged from the analysis above (`gauntlet.summary`
already confirms AC2 was genuinely exercised, no defuse) — this is a check
fix, not a re-interpretation. `bun run quorum check` passes with the new
literal. **Probe (b) treatment now reads pass, pass — counts for PR /
GREEN-replicating**, superseding the "one post-check failed" line recorded
for T#1 in the ledger and Block 7 table.

### 5. Probe (c) control pass#1 (`…-ea34`)

**Attribution**: scenario debt (probe under-discriminates on one AC
sub-clause), not a check hole. Raw ledger read
(`coding-agent-workdir/.superpowers/sdd/progress.md`): dev's final review
found 2 Important + 1 Minor findings, dispatched exactly ONE fix subagent
covering all three (`"Final review fixes: one fix subagent… re-review
clean, Ready to merge: Yes"`), and correctly re-adjudicated the
already-parked Task 2 finding as still-Minor rather than reopening it — a
fully genuine, non-vacuous exercise of every AC clause, matching the
judge's own evidence citations exactly.

**Root cause**: diffed dev's SKILL.md (`fb7b0708`) against the PR's
(`1f97eda`) directly on the appliance. Dev already contains, near-verbatim:
*"If the final whole-branch review returns findings, dispatch ONE fix
subagent with the complete findings list — not one fixer per finding"*
(dev SKILL.md line 218-219) — the first half of AC2 is **not new PR
behavior**; the Block 7 header's premise ("Dev lacks these rules
entirely") is inaccurate for this sub-clause. Only the second half
(explicit "run exactly one scoped re-review… there is no second fix wave"
residual-adjudication language) is genuinely new PR content; dev's general
principles (its per-task fix-loop discipline plus the "don't skip the
re-review" red flag) evidently generalize well enough that a compliant
agent gets the whole sequence right anyway.

**Recommendation**: **not a check hole — no `checks.sh` fix needed** (its
own header comment already discloses judge-ownership of this exact
sequence; the deterministic floor is intentionally minimal by design).
**Documented negative result** for the probe's design: recommend the
controller consider re-scoping `sdd-final-review-single-wave`'s story.md
AC2 in a future revision to isolate the genuinely novel "no second fix
wave / residual adjudication" sub-clause from the pre-existing "ONE
dispatch, not per-finding" sub-clause, since the latter cannot discriminate
treatment from control. No re-run needed — this is a legitimate,
informative observation, not void.

### Block 5 spot-check — spec-context symmetric fails

One T + one C `gauntlet.summary` (one line each), per the pre-registered
"noisy at n=1" caveat:

- T (`…-9583`): *"the controller inconsistently fed spec context to
  subagents: task-reviewer prompts got the actual cited spec section
  pasted in, but implementer prompts only got a bare citation…"* —
  inconsistent-plumbing failure.
- C (`…-336a`): *"did NOT use the superpowers:subagent-driven-development
  skill… explicitly chose the executing-plans skill, reasoning the plan
  was 'small' enough…"* — skill-selection failure; the AC goes moot by a
  completely different route.

**Attribution**: two genuinely different failure modes, not one repeating
defect — matches the documented noisy-at-n=1 pattern (#1943 panel:
"quality-reviewer + spec-context-consumed proven noisy at n=1"), not a
directional PR signal. **Recommendation**: documented negative result, no
action beyond what Block 5 already planned.

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

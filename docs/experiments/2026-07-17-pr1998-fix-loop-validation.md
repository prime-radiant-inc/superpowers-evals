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
"019f6f24-4017-7753-a6b7-e1fc6f6e74c0"}` — success, not an error. The raw
event confirms the target's `agents_states` was `"running"` (i.e. genuinely
live, not `pending_init` or `completed`) at the moment `send_input` was
accepted.

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

### Block 1 — Replication core

| Arm | Agent | Scenarios | n each | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | 3 (all) | 3 | |
| Treatment (PR) | claude | 3 (all) | 3 | |
| Control (dev) | codex | 2 (unpinned breakers) | 3 | |
| Treatment (PR) | codex | 2 (unpinned breakers) | 3 | |

Planned: 30 runs (18 claude + 12 codex).

### Block 2 — Coin-flip base rate

| Arm | Agent | Scenario | Additional n | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | sdd-fix-loop-resumes-implementer | 4 (→ n=7 cumulative with block 1) | |

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

## Economics

Spec estimate (Run matrix "Totals"): ≈80 measured runs + ≤8 triage-gated
contingency ≈ $270–390. Actuals recorded here per batch as the campaign
runs (obol-priced coding-agent cost + gauntlet grader spend, tracked
separately per the preflight's grader-budget note — grader bills the
shared direct-Anthropic key, a distinct exhaustible budget from the
`opus_bedrock`/`openai_responses` coding-agent credentials).

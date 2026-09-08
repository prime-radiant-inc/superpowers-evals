# Conversation startup and Pi evidence

Date: 2026-09-08
Status: Draft for discussion; implementation and live qualification are not authorized by this document.

## Outcome

A conversation begins with a configured coding harness ready to accept the
scenario request. The simulated user then conducts the task. Pi conversations
retain usable chronology, source-session identity and honest cost estimates.

This increment addresses two observed engine defects in the existing Quorum
worker. It does not establish grading accuracy, full harness coverage or a new
parallelism limit. Natural-language scenario briefs, live harness interaction,
appliance ownership, ordinary campaign polling and standardized reports remain
the product shape. Completed bad work remains an assessable result.

## Evidence and baseline

The [closed reliability experiment](../../experiments/2026-09-08-conversation-reliability/results.md)
provides the starting evidence:

- A Claude conversation exited before receiving its task. The simulated user
  repeated Enter after a timed-out transition, accepting the next menu's default
  “No, exit.” Prompt instructions already prohibited this behavior.
- Pi completed useful work, but its normalizer omitted timestamps. Production
  exposure calculation therefore excluded the result. Its custom provider also
  supplied placeholder zero cost, which the normalizer passed to Obol as
  authoritative. Three native sessions and their raw evidence were retained.
- Grading has separate defects: one correct criterion vector received a
  contradictory overall status; two bad design proposals received false passes.
  Repairing engine instrumentation alone cannot fix those judgments.

Design baseline: Quorum `7aad7f0af36f58caae250484df6272822b42bdaf`, Gauntlet
`187a9af979a7cf096c0890d0eeb998cc3008343a`, installed Claude 2.1.209 and Pi 0.80.7.
The installed image inspected during design is
`sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`.

## Startup decision

**Proposed boundary:** the engine owns initialization; the simulated user owns
the scenario conversation. Drew has been asked to confirm this boundary. It is
the draft assumption, not an answered question.

| Approach | Assessment |
| --- | --- |
| Preconfigure the private home and wait for the task prompt | Preferred; prove feasibility before adding startup input automation |
| A closed Claude startup routine in the existing terminal session | Fallback if configuration cannot preserve authentication; requires a revised design decision |
| More simulated-user instructions or another terminal controller | Instructions already failed; a second controller complicates process and capture ownership |

Read-only inspection of the actual installed Claude binary confirms that
`hasCompletedOnboarding` gates its onboarding UI and
`skipDangerousModePermissionPrompt` gates its bypass confirmation. This is source
evidence, not proof that a prepared launch authenticates and works. The current
Quorum provisioner documents an authentication failure with `IS_DEMO`; it does
not establish that `hasCompletedOnboarding` alone has the same failure.

CSD provides useful prior art for the bypass setting. Its complete driver owns
another session lifecycle and changes tool availability, including disabling
`AskUserQuestion`. Importing that driver would change the interaction under test.

### First gate: configuration feasibility

Before production changes, run a bounded offline probe using the exact installed
Claude CLI, generated launcher and isolated home in a container with external
networking disabled. Seed `hasCompletedOnboarding: true` through the existing
mirrored config writes and use `skipDangerousModePermissionPrompt: true` in
Claude's settings. Preserve existing trust, plugin and credential setup; do not
use `IS_DEMO`.

With dummy API-key credentials and a scripted loopback provider, the probe must
reach the task prompt without menu input, accept a neutral request and produce
a native response/session through the local API route. Separately exercise the
current Mantle startup configuration with dummy credentials through readiness;
do not build a fake AWS service to extend the probe. Include a delayed launch
and clean termination of owned processes. An idle prompt is not authentication
proof. Real Mantle routing and credential validity require the later live gate.

If this fails, retain the exact failure and discuss the closed Claude routine.
Do not quietly expand this work into a screen-navigation framework. Existing
OAuth provisioning must retain its behavior; this increment adds no auth mode.

### Implementation shape if the gate passes

Quorum owns per-harness configuration in `src/agents/index.ts` and selects a
closed Claude readiness check when invoking `gauntlet converse` from
`src/runner/conversation.ts`. Gauntlet applies that check after its existing
`adapter.start()` and before the first simulated-user `client.chat()`.

The check observes the existing terminal. It sends no keystrokes and succeeds
only on a recognized ready prompt from a live subject. An arbitrary nonempty
screen, changed bytes or elapsed time cannot establish readiness. Known startup
menus and authentication errors cannot match ready. Subject exit or readiness
timeout ends startup with explicit engine-error evidence. Cancellation retains
its existing stopped status. Use a 30-second readiness limit inside the current
overall conversation deadline; validate that limit against the delayed-start
tests and installed probe before freezing it.

Keep the existing private tmux socket, capture methods and cleanup owner. Record
readiness or failure with its final screen in existing evidence paths. Remove
only the simulated-user instructions assigning it Claude startup navigation.
Other held prompt changes remain unpromoted. Codex and Pi keep their current
launch paths; this is not a declaration that every harness now has readiness
qualification. There is no generic callback protocol or screen-matcher DSL.

## Pi evidence repair

Carry the held Pi conversation admission (`8931f61d`) and private-session
directory (`3c06b693`) changes together. The session regression depends on the
admission path; review their combined diff against the current baseline.

Make the fidelity correction at `src/normalize/pi.ts`:

1. Copy each native message row's timestamp onto its derived user/agent steps.
   Multiple tool steps from one inference share that row's timestamp. Missing
   timestamps remain missing; never substitute file time or normalization time.
2. Preserve the native header session ID on each emitted step as
   `extra.source_session_id`, as well as on the individual trajectory. Existing
   chronological merging then retains both time order and source identity.
3. For Pi's `quorum` custom provider, omit embedded `cost_usd` and preserve its
   token buckets. Use existing frozen Obol rates for cost. Unknown models remain
   explicitly unpriced; native cost for other providers keeps its current meaning.

Do not inject a second rate table into the launcher. Do not change the ATIF
schema, general merge algorithm or unused raw-Pi exposure parser to repair a
production path that already consumes ATIF. Source-session identity does not
claim a parent/child actor graph. Raw logs remain authoritative evidence for
custom events not represented by the current normalizer.

## Verification and delivery

Test behavior through the existing boundaries:

- Startup: no simulated-user request before ready; ready releases exactly once;
  delayed/unchanged/menu screens do not release it; exit, timeout and cancellation
  retain evidence and clean up the owned terminal. Execute the real paired CLI
  and tmux path with a local scripted provider, not rendered-command assertions.
- Pi: message timestamps, multi-tool usage counted once, preserved session IDs,
  and flat/nested logs whose filename order differs from chronological order.
  Exercise actual capture and Obol pricing, including an unknown-model case and
  preservation of non-Quorum native costs.
- Replay the retained private Pi evidence into a separate derived directory.
  Expect the same 80 steps and 908602 tokens, three source IDs, first exposure
  `2026-09-08T19:33:32.640Z`, and $0.9062072 under the original frozen rates.
  This is a pricing-contract estimate, not an invoice. Keep every original byte.
- Reuse the installed Pi deep-path session proof, then exercise the actual
  generated launcher with a local response to validate capture through pricing.
  Run required repository checks and review each deliverable before integration.

Startup and Pi can ship independently once their own gates pass. Use direct main
integration and canonical appliance installation as Drew previously requested;
verify exact installed revisions separately from source tests.

Proposed later live qualification is deliberately small: one Claude conversation
for startup, then Pi pricing and Pi review if pricing passes. Register fresh
identities and specify revisions, new limits and stopping rules before launch.
The prior campaign and its unused allocations are closed. No new run or spend is
authorized here. These cells would qualify these paths, not prove high parallelism
or broad grading accuracy.

## Following increment: grading contract

Keep this as a separate decision after engine evidence is usable. A promising
direction is to make overall assessment status a deterministic reduction of
criterion results: any proven failure means fail; all pass means pass; otherwise
the assessment is uncertain. Execution and assessor errors remain separate.

That eliminates the last candidate's redundant, contradictory overall judgment.
It does not fix the two false-pass criterion judgments. Use the frozen transcripts,
outputs and independent judgments to settle that semantic problem before another
prompt comparison. Do not change the generic Gauntlet QA validator or promote a
held assessor candidate as part of this engine repair.

## Scope boundary

No new orchestrator, campaign recovery, scenario exchange scripting, generic
harness interface, session graph, billing reconciliation or statistics layer.
After startup, Pi evidence and grading have distinct proof, the next product
checkpoint is a small mixed-harness batch through the ordinary appliance path.
Broaden supported pairings and concurrency from that evidence.

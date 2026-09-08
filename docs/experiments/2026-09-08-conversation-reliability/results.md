# Conversation reliability increment — 2026-09-08

The bounded experiment is closed. Only the failed-run publication repair and
typed assessor tool-error propagation qualified for delivery. Pi qualification,
the simulated-user prompt changes and the new assessor instruction candidate
remain unpromoted. There were no replacement calls, controls, second candidate
or Pi review run. Existing reports and negative evidence remain unchanged.

This increment does not establish broader harness coverage or improved grading
reliability. It identified concrete failures at startup, native transcript
normalization and accounting within the current conversation path.

## Frozen experiment

- Spec and plan: `docs/superpowers/{specs,plans}/2026-09-08-conversation-reliability*`.
- Runtime Quorum: `0a69d7c2d9c55e12d8b138d7d2725b286c670a67`.
- Retained assessor candidate: Gauntlet `2d3c18cef537425d2d1765bfc0c3002723b30e30`.
- Fresh conversations: Gauntlet `ed9cb8058081261f9acd2c78fc049799560188bf`, using the baseline assessor prompt plus the driver and protocol changes.
- Superpowers: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.
- Fresh worker image: `sha256:f45020decb13169ae12d3051382ffb8efb6a395c2c78a18a9fce516a1a85fcb8`.
- Exact envelopes are recorded in `execution-freeze.json` and `fresh-execution-freeze.json`. The first retained call began at 19:23:43Z; the overall cutoff was 23:10:00Z.
- Limits: $8 retained/$12 fresh observed allocation, no transfer; at most 24 retained calls and 8 fresh conversations; cap 4; 120-second assessment calls, 600-second conversations and 900-second attempts. These stopping allocations are not hard billing caps.

The initial retained metadata used an inherited wrong relative prefix. Strict
remote input loading and independent review caught it before provider calls.
One metadata correction changed the references to
`../2026-09-08-conversation-release/` and updated their hashes. Evidence,
expectations, rubric bytes, case order and operator behavior were unchanged.
Both preflight failures and the corrected freeze remain preserved.

## Retained assessor result

Only `known-claude-review-candidate-1` ran. Its valid structured report was
`investigate`, with criteria `[pass, pass, pass, fail]`; the frozen overall
judgment was `fail`. The operator stopped because its accepted result contract
requires `pass/0` or `fail/1`. Its `instrument_failure` stop label does not mean
the report was malformed. Independent adjudication found the alternative
criterion 4 rationale materially supported; the overall judgment still failed
the gate. No second repetition or constructed control ran.

The call cost $0.1263944 with complete priced usage. This is one negative
candidate observation, not a fresh baseline comparison or error-rate estimate.
The older candidate and all previous reports remain frozen.

The separately selected protocol correction carries the assessor's existing
error decision as typed `isError`, serialized as Anthropic `is_error:true` in
both text and image tool results. Actual-SDK offline tests prove malformed
reports are rejected and the next request preserves the error flag, history,
usage and tool-use identity. This live call did not exercise malformed-report
repair and therefore does not establish better model repair behavior.

## Pi pricing qualification

Campaign `4d0d37a7-035f-4024-b2e9-b48a99ecf2a1` completed its one pricing
conversation in 315.248 campaign seconds. Run:
`conversation-pricing-pi-pi_gpt56_sol-linux-20260908T193318Z-bb41`.

The explicit private session directory fixed the real installed startup
failure. Offline testing exercised the exact Pi 0.80.7 session manager in the
installed image at an encoded cwd over 255bytes, with networking disabled and
dummy credentials. The old launcher reproduced `ENAMETOOLONG`; the corrected
launcher selected the private session directory, including a space in its
ancestry. Live publication retained the main session and two nested reviewer
sessions, all matching the fixture cwd, plus outputs and 80 normalized steps.
Termination was verified. Independent judgment, frozen before official-grade
exposure, was `[pass, pass]` with faithful simulated-user behavior. Intermediate
patch/reviewer failures remained visible and did not invalidate the final work.

Qualification nevertheless failed on two independent instrumentation defects:

1. `normalizePi` omits step timestamps. The production controller derives
   exposure solely from the published ATIF trajectory, so it received null
   exposure and excluded the result. A separate raw-Pi exposure parser has no
   production caller. This was not host contention or publication failure.
2. Pi's custom model registration supplies no rates, so native usage carries
   zero cost. The normalizer copies that zero into ATIF and Obol trusts embedded
   cost. The published complete-looking $0 subject cost is false. Repricing an
   explicitly derived copy without embedded cost, through the real frozen Obol
   rates, yields $0.9062072 for 908602 subject tokens. Original artifacts were
   not edited. Cache-write classification is not invoice-verified; treating
   those tokens as ordinary input instead would yield $0.8347012.

Additional evidence limitations: nested sessions are appended without actor
identity or timestamps, and one native custom subagent-failure event is omitted
from ATIF. Raw and visible evidence preserve it. The official assessor also
misidentified an initial user message as the agent's clarification; independent
inspection found the actual clarification. Agreement on outcomes does not make
every official citation accurate.

The registered Pi review campaign
`fdd61cfc-d23e-4e94-8acb-0bbe533e2e70` remains unlaunched. The startup patch's
meaningful conversation regression depends on Pi admission; neither combined
Pi change was selected for this delivery. The passing startup proof remains
available for a coherent subsequent fix.

## Claude/Codex driver batch

Campaign `bf7500a7-c83a-48e5-82cf-a51b8b358f36` admitted the frozen six
cells at cap 4. Three completed with authenticated usable results: Claude and
Codex design, and Claude review-feedback repetition 1. Claude feedback
repetition 2 exited during startup; two Codex feedback attempts were interrupted
by cancellation. Final state is `cancelled`, `complete:false`, with
`termination_verified:true`. Independent audits are recorded separately from
official grades below.

The failed Claude attempt was a simulated-user navigation error. After Enter
on security notes, the driver saw an unchanged capture and waited 1.5 seconds.
That wait timed out. It pressed Enter again at 19:55:27.704Z, after Claude had
advanced to Bypass Permissions; the key confirmed default `1. No, exit`.
The retained screen and pane status 1 support that sequence. Later Down was
correctly refused because the subject had already exited. The generated HOWTO
and driver prompt explicitly required waiting for a changed screen and
prohibited repeated Enter through menus. Claude 2.1.209 and the launcher behaved
normally. The scenario request was never submitted, no native subject session
was created and assessment did not start. This is not a Claude behavioral
failure or refusal. A prior breadth attempt exhibited the same navigation bug.

Cancellation was requested under the missing-usage/instrument stop rule. The
first helper call recorded cancellation intent but could not acquire the live
lease while the controller still held it. A later helper reconciliation
terminated the campaign normally. No lock was manually removed. Final doctor
was healthy; run/sync locks and shared spend lease were absent.

The final report authenticated 1206 artifacts. All were hashed on the appliance
and after local transfer. Codex feedback repetition 1 has no bound manifest:
1003 partial files, including two native logs, were copied into a separate
private diagnostic archive with hashes. They are not authenticated publication
or a completed result. Repetition2 published partial evidence but lacks complete
subject usage and an accepted observation. Missing billing remains unknown.

The Claude startup failure itself now has a
valid publication retaining its $0.022455 driver usage and explicit missing
subject usage, rather than inventing a zero-cost successful run.

### Independent completed-case audit

The independent audit was frozen before official exposure, SHA256
`71beee8d1979bbdcfaa8044eeede4d4605c2fe3e2f5bdacd9fc5e0dde0a90a0a`.

| Completed trial | Official criteria | Independent criteria | Finding |
| --- | --- | --- | --- |
| Claude design | pass/pass/pass | fail/fail/pass | Never asked which tasks to watch; proposal notifies for every completion |
| Codex design | pass/pass/pass | fail/fail/pass | Same missing watch choice and watched-task interaction |
| Claude review-feedback | pass/pass/pass/pass | pass/pass/pass/pass | Correct admission fix, retained monotonic clock, justified deferral of Redis |

Both design outcomes are completed bad proposals and false passes. Their
substantive local/in-page designs and unchanged source files remain useful
signal; the unchanged-page oracle cannot validate proposal semantics. Neither
driver disclosed the missing conditional watch preference, so the omission was
not repaired by coaching. Claude design's driver adhered; Codex's driver was
substantively neutral but supplied local/no-backend context while answering a
notification-channel question. The audit preserves that disclosure qualification.

Review-feedback's driver supplied relevant facts neutrally, but continued after
the subject had already fixed and tested the admission condition and explained
both declined notes. The subject also asked follow-up questions and whether to
commit, making the stopping point ambiguous. Under the brief's literal
stop-at-disposition rule this is a deviation; the correct engineering result
already existed before continuation. Extra verification, commit and home-memory
writes remain visible. No tests were rerun for the audit.

The confirmed startup violation, endpoint concern and incomplete six-cell gate
hold both driver prompt and design-brief changes. Official reports remain
unchanged. Separate adjudication, SHA256
`61fc831ad0c028cc3c022ee7ae4e54f00b783a3a0a2fe41c237067cd3aed9da5`,
confirmed the material error: the Claude grader called choosing a minimal seeded
list "settling which tasks to watch"; the Codex grader conflated which tasks
exist with which are watched. Both substituted generic completion-to-toast
behavior for the required watched-task relationship. The feedback PASS is
supported, although its grader mislabeled the simulated user as the reviewer
and attributed the subject's choice of commit-message placement to the user.
Neither attribution error changes the feedback outcome.

## Accounting

| Stream | Published known subtotal | Coverage and interpretation |
| --- | ---: | --- |
| Retained candidate | $0.1263944 | One complete priced assessment |
| Pi driver plus assessor | $0.718591 | Subject's published $0 is rejected; derived subject estimate $0.9062072 separately |
| Six-cell driver batch | $3.7504135 | Subject observed 3/6, grader observed 5/6; incomplete |

Published known subtotal is $4.5953989. Adding the derived Pi subject estimate
gives $5.5016061 accounted for across this increment, including $5.3752117 in
the fresh stream. These figures exclude unknown interrupted usage and are not
reconciled invoices or proof of final spend. No unused allocation was transferred
and no additional provider work was launched.

## Delivery selection and verification

Quorum publication commits `0ba9c02c` and `f3275c76` recurse through unlisted
directories using the existing verifier. Meaningful tests prove a recursively
empty failed-run tree publishes its available evidence while unlisted files
and symlinks remain refused. Existing schema, identity and authentication rules
are unchanged. Gauntlet `187a9af` contains only the typed tool-error protocol
delta from `5c0fd18`; it excludes both experimental prompts.

The dated operator, its behavioral tests, approved spec/plan and frozen inputs
are preserved in a separate archival commit `28ebf13b`. They add no production
CLI or automated provider work. All Pi admission/startup code, new qualification
suites, driver changes and assessor instruction candidate remain on experimental
branches. Selected-tree independent review passed: exact source matches the reviewed
publication/protocol deltas, with no held runtime or missing dependency.
Final-main CI and canonical installation remain separate delivery gates.
Their exact job/ref receipts will be retained with the private operator ledger
and delivery record after those gates complete.

Root verification on the selected runtime:

- Quorum required check: 3735 core passes, 20 environment skips, 144 dashboard passes; lint/typechecks and scenario validation passed.
- Gauntlet required check: 1352 passes, 2 provider-gated skips; core/UI typechecks and both UI builds passed.
- Actual paired CLI with real tmux and scripted loopback provider: 5 outcomes, 162 assertions, no external provider calls.
- The first selected Gauntlet check had 5 tmux socket-path failures because root's temporary directory used the long macOS default. The same tree passed with a short isolated `/tmp` directory, as earlier checks used. Both receipts remain; no code, timeout or assertion was weakened.

Private reports, evidence, cost reconciliation and review receipts are under
`results/conversation-reliability/` in the reliability coordinator worktree.
Detailed independent audits and source diagnoses are in its
`.superpowers/sdd/2026-09-08-conversation-reliability/` ledger. On the appliance,
the pilot remains at `/srv/quorum/pilots/conversation-assessment/`; campaign IDs
above identify the ordinary campaign reports. Sensitive raw evidence remains
private.

## Next bounded work

Repair the actual startup interaction boundary so a timed-out screen transition
cannot be treated as permission to repeat Enter into another menu. Separately,
preserve Pi timestamps/session identity and make custom-model pricing honest
before another Pi qualification. Revisit the assessor's fail-versus-investigate
behavior against the already frozen judgments without changing gold to fit its
answer. These require a subsequent scoped design/authorization; this experiment
does not resume automatically. No evidence here supports changing orchestrators
or building deeper statistics before these contracts work.

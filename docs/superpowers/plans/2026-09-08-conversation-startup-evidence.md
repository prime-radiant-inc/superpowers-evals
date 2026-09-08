# Conversation startup and Pi evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare independently reviewed Claude startup and Pi evidence repairs for bounded live qualification.

**Architecture:** Quorum configures private harness homes; Gauntlet observes Claude readiness in its existing tmux session before any simulated-user request. Pi native metadata feeds existing ATIF capture and frozen Obol pricing. Existing workers own execution and cleanup.

**Tech Stack:** TypeScript, Bun, tmux, installed Linux Claude 2.1.209 and Pi 0.80.7.

**Spec:** `docs/superpowers/specs/2026-09-08-conversation-startup-evidence-design.md`

## Global Constraints

- The engine owns initialization; the simulated user owns the scenario conversation.
- Completed bad work remains an assessable result.
- Missing timestamps remain missing; never substitute file time or normalization time.
- For Pi's `quorum` custom provider, omit embedded `cost_usd` and preserve its token buckets.
- Other held prompt changes remain unpromoted.
- No new orchestrator, campaign recovery, scenario exchange scripting, generic harness interface, session graph, billing reconciliation or statistics layer.
- No paid calls during Tasks 1–4. Use dummy credentials and external-network isolation for installed probes. Live qualification and canonical promotion remain gated by the spec.
- Preserve original evidence, held branches and existing worktrees. Use isolated task worktrees and retain the progress ledger.
- Tests exercise behavior and structured contracts, not large rendered scripts or command strings.
- Continue PRI-3102. Integrate directly to main only after the separately bounded live gate; no PRs.

## Ownership and dependencies

Task 1 owns an offline probe and its receipts. Task 2 independently owns Pi runtime/tests in a separate Quorum worktree. Task 3 depends on Task 1 and owns Claude runtime/tests across separate Quorum/Gauntlet worktrees. Task 4 combines reviewed commits and validates the paired candidate; it does not launch a paid qualification.

Baseline runtime: Quorum `7aad7f0a`; Gauntlet `187a9af9`. Coordinator branch contains only the approved design and this plan beyond that runtime.

### Task 1: Prove configured Claude startup offline

**Files:**
- Create: `docs/experiments/2026-09-08-conversation-startup-evidence/claude-probe.py` (dated offline probe, not a new product CLI).
- Create: `docs/experiments/2026-09-08-conversation-startup-evidence/claude-startup.md` (redacted receipts and conclusion).
- Read: `src/agents/index.ts`, `coding-agents/claude-context/launch-agent`, existing installed probe examples.

**Interfaces:** Produces a receipt with image digest, CLI version, generated-launcher hash, direct API response/native-session result, Mantle ready result, observed composer signature, elapsed time and verified cleanup. Task 3 consumes these captures and conclusion.

- [ ] Generate the actual baseline launcher through provisioning with dummy credentials. Work only in an owned temporary directory/container, no credential bundle mount. Use the installed image by digest and `--network none`; the scripted provider runs on loopback inside that container.
- [ ] Seed the narrow settings in the throwaway probe home:

```python
config['hasCompletedOnboarding'] = True
settings['skipDangerousModePermissionPrompt'] = True
```

  Apply config in both paths the current provisioner mirrors. Do not set `IS_DEMO`, remove plugins, disable `AskUserQuestion`, or change harness permissions beyond the existing launch mode.
- [ ] Launch the actual CLI through tmux. Capture ready without input, then submit a neutral request only to the direct API loopback fixture. Return an Anthropic message with text and nonzero usage using the current paired test's local-provider pattern; observe the native session. Cap requests and use a fixed probe deadline and `finally` cleanup.
- [ ] Exercise dummy Mantle configuration to the task composer only, and one delayed direct startup. Capture theme/security/bypass screens as failures, not steps to navigate. Record the actual positive composer signature for Task 3.
- [ ] Verify all probe children/container processes terminated, hash retained receipts, and commit the probe plus concise conclusion. A configuration failure stops Claude implementation; report the evidence without building a state machine. Pi work may continue.

### Task 2: Preserve Pi chronology, source identity and honest pricing

**Files:**
- Carry reviewed dependencies: commits `8931f61d` and `3c06b693` onto the baseline, resolving only current-source context.
- Modify: `src/normalize/pi.ts`.
- Test: `test/normalize.pi.test.ts`, `test/capture.test.ts`, `test/obol.test.ts`, plus held admission/session tests.

**Interfaces:** Existing `normalizePi(raw: string, version: string): AtifTrajectory` remains unchanged. Each emitted step gains native `timestamp` and `extra.source_session_id` when present. `metrics.cost_usd` is omitted for provider `quorum`; existing Obol pricing consumes retained token/model/provider fields.

- [ ] Establish focused clean baseline, then carry admission/private-session commits together. Record exact base and resulting commits.
- [ ] Add red regressions using real Pi JSONL structure and the existing fixture. Assert native timestamps on user, text-only and multiple-tool steps; shared inference usage appears once. Assert source IDs survive capture of three nested/flat logs whose path order disagrees with time order.

```ts
expect(trajectory.steps[0]?.timestamp).toBe('2026-09-08T19:33:32.640Z');
expect(trajectory.steps[0]?.extra?.source_session_id).toBe('main-session');
```

  Construct the matching message row/header in the test; do not apply these invented IDs to retained evidence.
- [ ] Preserve each message row's timestamp and header session ID while constructing its steps. Merge with existing usage metadata rather than overwriting it. Only copy a valid native timestamp; missing/invalid input must not create an invented one.

```ts
if (cost !== undefined && provider !== 'quorum') metrics.cost_usd = cost;
```

- [ ] Test actual Obol with omitted `quorum` placeholder cost, a frozen known-model rate and unknown model. Non-Quorum native cost stays embedded. Run the affected normalizer/capture/Obol/admission/session suites and typecheck/lint.
- [ ] Replay private retained Pi evidence to a separate derived directory using actual capture/pricing. Preserve originals. Verify 80 steps, 908602 tokens, three IDs, first exposure `2026-09-08T19:33:32.640Z`, and original frozen estimate $0.9062072. Root provides the discovered private input location; workers never publish transcripts.
- [ ] Commit and write a report with red/green commands, results, exact source refs and replay receipt. Do not change the unused raw-Pi exposure parser, general merge algorithm or ATIF schema.

### Task 3: Configure Claude and gate the simulated user on readiness

**Dependency:** Task 1 must prove configuration feasibility and provide actual composer captures.

**Files:**
- Quorum: `src/agents/index.ts`, `coding-agents/claude-context/launch-agent`, `src/runner/conversation.ts`, `test/agent-claude.test.ts`, `test/claude-mantle-provision.test.ts`, `test/runner-conversation.test.ts`, `test/runner-conversation-gauntlet-integration.test.ts`.
- Gauntlet: `src/conversation/converse.ts`, `src/cli/args.ts`, `src/cli/converse.ts`, new `src/conversation/claude-startup.ts`, `test/conversation/converse.test.ts`, existing CLI argument tests and new focused startup test file if useful.

**Interfaces:** Add optional closed `startup?: 'claude'` to `ConverseOptions`, parsed by `gauntlet converse --startup claude`. Quorum supplies it only for the Claude normalizer. Add `isClaudeReady(screen: string): boolean`, based on Task 1 captures. Keep readiness waiting inside the conversation's current deadline/capture/cleanup lifecycle; no generic callbacks or terminal driver.

- [ ] Establish affected-suite baseline. Add red behavior tests: zero `client.chat` calls before ready; one release on ready; delayed/menu/auth-error screens do not match; exit, startup timeout, overall timeout and cancellation preserve evidence and cleanup.

```ts
expect(isClaudeReady(themeScreen)).toBe(false);
expect(isClaudeReady(bypassScreen)).toBe(false);
expect(isClaudeReady(composerScreen)).toBe(true);
```

  Fixtures come from Task 1. Use an executable delayed/exit fixture and scripted client for lifecycle assertions, rather than matching command text.
- [ ] Set the two narrow configuration values proved in Task 1 through existing private-home/settings mechanisms. Update only misleading comments/tests conflating onboarding state with `IS_DEMO`; retain OAuth and current credentials/plugins/trust.
- [ ] Wire the closed option through both CLIs and wait after `adapter.start()` and before `client.chat()`. Reuse capture/evidence methods, subject-exit checks, clock/deadline and `finally` cleanup. The check sends zero keys. Readiness subdeadline is 30 seconds capped by overall remaining time.
- [ ] Preserve errored startup, timed-out overall and stopped cancellation outcomes. Store a readiness/failure event and final screen in the existing evidence paths. For Claude's selected startup path, remove only instructions assigning startup navigation to the simulated user; preserve other harness behavior and held prompts.
- [ ] Run affected suites, actual paired CLI over tmux/local scripted provider, typechecks/lint. Commit separately in each repo, report exact paired refs and evidence. Do not import CSD or build startup menu automation.

### Task 4: Assemble and verify the candidate for live qualification

**Files:**
- Coordinator: `docs/experiments/2026-09-08-conversation-startup-evidence/results.md`.
- Candidate: reviewed Tasks 1–3 commits, existing private test/evidence directories.

**Interfaces:** Exact reviewed Quorum/Gauntlet commit pair; private machine-readable probe/replay receipts; proposed three-cell live gate with explicit new limits for Drew to review.

- [ ] Merge reviewed task commits into the coordinator candidate; preserve all experimental branches. Resolve the shared `src/runner/conversation.ts` dependency between Pi admission and Claude option selection, then run affected integration checks.
- [ ] Execute the generated Pi launcher in an owned network-isolated container at a deep path with a local scripted Responses fixture. Verify private session creation, timestamps/usage, capture exposure and actual frozen pricing. Keep the fixture bounded; it is an offline installed proof, not a new runtime service.
- [ ] Run Quorum `bun run check` and `bun run quorum check`; Gauntlet `bun run check`; actual paired conversation CLI integration with `GAUNTLET_ROOT=<exact candidate Gauntlet worktree> bun test test/runner-conversation-gauntlet-integration.test.ts`. Use short temporary socket paths. Preserve genuine failures; do not increase unrelated deadlines or weaken assertions.
- [ ] Generate immutable diff packages for task and final reviews. Resolve important findings through the assigned implementer and a scoped re-review. Final review covers both repos and the installed probe/replay receipts without duplicating test runs.
- [ ] Write outcome and exact commands/counts, source and image identities, residual limitations and a concrete live proposal: one Claude/Mantle pricing conversation; then Pi pricing and Pi code review gated on pricing instrumentation. Specify fresh identities, per-attempt/overall deadlines, a new finite spend allocation and stop rules. No automatic retries or old campaign continuation.
- [ ] Commit the record and leave reviewed candidate ready for the spec's live gate. Canonical installation/main promotion follows live qualification; new paid calls are not part of this offline plan.

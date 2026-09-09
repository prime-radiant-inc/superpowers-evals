# Conversation startup and Pi evidence results

Date: 2026-09-08
Status: offline checks passed. Subsequent authorized live qualification and
promotion are recorded in [live results](live-results.md).

## Question

Can the existing worker start Claude without assigning menu navigation to the
simulated user, and retain usable Pi conversation evidence through capture and
frozen pricing? This increment tests those engine paths. It does not qualify
grading accuracy, additional harnesses or parallel capacity.

Runtime baseline: Quorum `7aad7f0af36f58caae250484df6272822b42bdaf`, Gauntlet
`187a9af979a7cf096c0890d0eeb998cc3008343a`, and Superpowers
`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`. Installed probes used image
`sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`
with dummy credentials and external networking disabled. The image digest is
recorded in each detailed receipt; canonical installation was unchanged during
the offline phase.

## Evidence established

| Check | Outcome | Evidence |
| --- | --- | --- |
| Configured Claude 2.1.209 | Ready without input; one neutral direct request produces an assistant response with nonzero native usage | [Claude probe](claude-startup.md) |
| Delayed Claude and dummy Mantle | Same observed composer without startup input; no provider request submitted | [Claude probe](claude-startup.md) |
| Pi retained evidence replay | 80 steps, 908602 tokens, three native source IDs, first exposure `2026-09-08T19:33:32.640Z`, frozen estimate $0.9062072 | Reviewed Pi implementation `325790fc`; private replay receipt |
| Installed Pi 0.80.7 | Actual interactive launcher, private session, native assistant response and 150 tokens; two timestamped ATIF steps and $0.000982 frozen estimate | [Pi probe](pi-installed-probe.md) |

The Pi repair carries its admission and private-session changes together. It
preserves native message timestamps and source IDs, and omits the `quorum`
provider's placeholder embedded cost so existing Obol pricing applies. Unknown
models remain unpriced. The retained replay's three original native files were
rehashed without modification. Pricing is an estimate under the frozen table,
not a provider invoice.

Claude's config probe found that API-key approval was added after the initial
config mirror, leaving the top-level file incomplete. The successful probe
mirrors final approval/trust state, sets onboarding complete in both files, and
merges the bypass-prompt setting. It preserves the generated launcher and plugin.
Its loopback-only endpoint setting is a probe fixture, not a new production
routing feature. Dummy Mantle readiness does not prove real authentication.

The implementation completes those config mirrors and selects the closed
`--startup claude` path. Gauntlet waits for the recognized composer before its
first simulated-user request and sends no startup input. It retains initial and
changed startup screens using its existing capture writer. If Quorum must stop
the process, the fallback record can reference the last durable startup screen;
it does not claim an atomic snapshot at the instant of termination. Completed
startup events prevent a later interruption from borrowing a stale ready screen.

## Negative results and review corrections

- Claude's early probe ran as root, then exposed missing approval in one config
  copy, then rejected a real composer using an invented shortcuts marker. An
  incorrectly reconstructed Mantle credential was excluded and replaced by the
  actual registry shape. These results remain retained.
- Review rejected the first direct-response proof because both the terminal and
  native substring checks could accept the echoed user request. The corrected
  probe requires a distinct native assistant message with its own nonzero usage
  and a separately visible answer. Two no-request submission failures were
  retained before using the existing Gauntlet literal-text submission sequence.
  The corrected receipt and native evidence passed scoped review.
- Pi's first installed pricing attempt used bundled rates because
  `OBOL_PRICING_DIR` was unset. The expected frozen price was derived independently
  and retained; selecting the authenticated snapshot before module initialization
  produced that price. An intermediate functional pass lacked its claimed outer
  timeout and was excluded; the final runtime receipt records the enforced bound.
- The affected Pi admission/session test repetition initially failed under the
  default macOS temporary path. Root's exact-head rerun with canonical short
  `TMPDIR=/private/tmp` passed 60 tests and 206 assertions. The earlier failure is
  retained; host load was not established as its cause.
- Task review found that tmux's styled output could fail the plain-screen
  readiness predicate, and forced termination could lose an unpersisted startup
  screen. The correction normalizes terminal styling and preserves startup
  observations before interruption. Styled paired tests and actual outer-role
  cancellation/deadline tests now pass with zero early provider requests, usable
  evidence and subject-process cleanup. Both findings passed scoped re-review.

## Candidate validation

Pi's focused normalizer/capture/Obol checks passed 82 tests and 215 assertions;
lint and typecheck passed. Source review found no implementation defect. The
60-test affected admission/session run above resolved its validation finding.

Validated paired runtime: Quorum
`2d71009cc52a5a3b994f1a385ea136abb5c15b78` and Gauntlet
`f5d66447ce4234fd5c0901fad372935332003491`. Subsequent experiment-record commits
do not change that runtime.

| Final check | Result |
| --- | --- |
| Quorum `env -u GAUNTLET_ROOT TMPDIR=/private/tmp bun run check` | Lint/typecheck passed; 3744 tests passed, 22 skipped, zero failed, 20719 assertions; dashboard typecheck and 144 tests passed with 393 assertions |
| Quorum `bun run quorum check` | All scenarios, credentials, arms and suites valid |
| Gauntlet `env -u GAUNTLET_ROOT TMPDIR=/private/tmp bun run check` | Both typechecks and UI builds passed; 1357 tests passed, two skipped, zero failed, 3539 assertions |
| Quorum `GAUNTLET_ROOT=<candidate Gauntlet worktree> TMPDIR=/private/tmp bun test test/runner-conversation-gauntlet-integration.test.ts` | Seven actual CLI/tmux/local-provider cases passed with 183 assertions |

The Quorum full check omits the seven explicitly enabled paired cases, which
were then run separately on this assembled tree. Its other 15 skips are
conditional Windows, Docker and legacy integration checks. Gauntlet's two
conditional API-client tests remain skipped. These checks do not establish a
full Linux container qualification, real provider authentication or concurrency
capacity. Full logs and task-review receipts are retained in the private ledger
and results directory. No pre-commit hook was bypassed.

## Decisions during implementation

The installed probes themselves serve as the behavioral tests; no additional
tests of rendered probe scripts were added. A probe defect could invalidate its
conclusion, so the receipts and assertions received independent review. That
review found and corrected the direct-response false positive above.

The Claude loopback endpoint was supplied through private settings to preserve
the actual generated launcher. A throwaway launcher with one explicit endpoint
variable was permitted only as a fallback and was never used. Treating either
local method as real routing proof would overstate the evidence; Mantle
authentication remains a separate live gate.

## Subsequent live gate

The [live qualification](live-qualification.md) used three finite cells through
the existing appliance pilot: Claude pricing, Pi pricing, then Pi review after
Pi pricing instrumentation passed. Drew separately approved fresh identities,
pinned inputs, one attempt per cell, no reserve, a new $10 observed allocation
and a 60-minute wall limit. All three passed their engine gates for $2.53704565;
the [live results](live-results.md) record their evidence and subsequent direct
main/canonical campaign promotion. Previous campaigns and allocations stayed
closed.

Execution, assessment and accounting remain separate. A completed bad
implementation or review is useful evidence; a behavioral pass is not the engine
admission gate. Held grader and simulated-user prompt candidates remain
unpromoted. Each delivered engine repair passed its own live gate before direct
main integration and canonical campaign installation.

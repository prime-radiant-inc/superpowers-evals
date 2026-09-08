# Conversation startup and Pi evidence results

Date: 2026-09-08
Status: offline implementation in progress; no live qualification authorized.

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
recorded in each detailed receipt; canonical installation remains unchanged.

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

## Candidate validation

Pi's focused normalizer/capture/Obol checks passed 82 tests and 215 assertions;
lint and typecheck passed. Source review found no implementation defect. The
60-test affected admission/session run above resolved its validation finding.

Final paired runtime identities, combined repository checks and broad review
will be recorded here after the Claude readiness implementation is integrated.
Until then this is not a completed candidate or a main-promotion receipt.

## Next gate

The [proposed live qualification](live-qualification.md) is three finite cells
through the existing appliance pilot: Claude pricing, Pi pricing, then Pi review
only if Pi pricing instrumentation passes. It specifies fresh identities, pinned
inputs, one attempt per cell, no reserve, a proposed new $10 observed allocation
and a 60-minute wall limit. No campaign has been registered or launched by this
offline work. Previous campaigns and their allocations remain closed.

Execution, assessment and accounting remain separate. A completed bad
implementation or review is useful evidence; a behavioral pass is not the engine
admission gate. Held grader and simulated-user prompt candidates remain
unpromoted. Each deliverable requires its own live gate before direct main
integration and canonical appliance update.

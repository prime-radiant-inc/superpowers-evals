# PR 2236 full-diagnosis comparison

Can the full `diagnosing-superpowers` workflow reconstruct a remembered native
session, assess the evidence behind its completion claim and repeated work, and
deliver a useful local report more reliably with the PR 2236 treatment than
with the pre-change runtime?

## Frozen design

The comparison has one before/after pair for each of Claude, Codex, and Pi:
six top-level attempts total. Every attempt receives one
`diagnosing-full-session` story with a 15-minute story limit and may dispatch
seven analysts, for 42 expected analysts across the experiment. Each top-level
attempt has `max_time_s: 1200` and `max_attempts: 1`. There are six graders, no
repeats, no reserve or rescue cells, and the registration must use global
concurrency two.

The before runtime is `d7bc5b0197d3f5358d8af03d4474ec3c826465be` and
the treatment runtime is `6ac8f0c0c9e256a619736388fd5c0b85c35c39a1` for
all three harnesses. Claude uses `opus_bedrock` with high effort, Codex uses
`openai_responses_56sol` with high effort, and Pi uses `pi_gpt56_sol` without
an effort override. The grader is `sonnet5` / `claude-sonnet-5`. The public
request text in `diagnosing-full-session/story.md` is frozen.

The primary hypothesis is that treatment reports will more completely and
accurately reconstruct the target session and linked child work. Secondary
comparisons cover evidence accuracy, support for the completion claim,
assessment of repeated work, report delivery, and compliance with the requested
investigation boundary. These labels do not encode target answers.

## Qualification and accounting

Registration requires an immutable private runtime derived from the public
implementation commit, with reviewed fixture bytes installed only in the
declared session stores. Qualification must verify the source and image
identities, harness versions, installed Superpowers packages, model and effort
routes, seven-child native behavior, child capture, ordinary-failure artifact
publication, finite admission, and pricing before any live launch.

Coding-agent accounting uses canonical ATIF and obol. Pi's evidenced API-key,
OpenAI Responses, `gpt-5.6-sol` custom-provider route has no native model rates,
so a recorded zero on that exact qualified route is preserved in ATIF metadata
and omitted as authoritative `metrics.cost_usd`; obol then prices the canonical
token buckets. Positive costs and zeros from other providers, models, OAuth, or
captures without the runner's qualification context retain their recorded
behavior. Frozen historical artifacts are not rewritten or counted as diagnosis
spend.

Safe validation consists of the focused configuration, normalization, capture,
and scenario-setup regressions plus `bun run check` and `bun run quorum check`.
Offline fake-provider and retained-trace checks qualify mechanics only; they are
not behavioral outcomes.

## Pending launch gates and deferred cases

The private fixture commit, runtime inventory, offline Linux evidence, final
cost estimate, proposed new allowance, finite-admission proof, and launch packet
remain operator-controlled artifacts. No new live spending is authorized by
this entry, and the earlier discovery allowance does not apply.

Windows and Antigravity are deferred. Additional repetitions, reserve or rescue
runs, similar-session search, GitHub actions, bundles, product fixes, and any
post-report retry are outside this experiment.

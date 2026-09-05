# Core comparison implementation and validation

**Date:** 2026-09-04

**Tracking:** [PRI-2874](https://linear.app/prime-radiant/issue/PRI-2874/quorum-overhaul-campaign-platform-comparative-evals-as-configuration)

**Status:** Core comparison is merged and pushed at `607b7818`. Post-push failure
repairs are complete and independently reviewed at `25ff1002`; the standard portable
gate and all 86 scenarios pass. The failures and their reproduced causes are recorded
below. Linux appliance, installed-appliance, paid comparison and timed usability
checks remain unperformed.

## Question and scope

Can one controller session deliver useful, configurable comparisons while preserving
Quorum's checks, runner, capture, frozen inputs, credential isolation and ownership
rules, without the budget controls and resumable execution machinery of the earlier
kernel? The approved design is
[campaign consolidation](../superpowers/specs/2026-09-04-campaign-consolidation-design.md),
with execution recorded in the
[core comparison plan](../superpowers/plans/2026-09-04-core-comparison.md).

Drew approved local implementation in a fresh worktree and explicitly deferred
resume/restart and coordinated subject lifecycle/error reporting. A subject
spawn/crash/rate-limit claim without reliable actor evidence remains indeterminate,
with no cause-derived retry or pool latch. Qualified authenticated grader evidence,
validity policy and all-attempt accounting remain in scope.

The implemented product has one Linux appliance, one live campaign, parallel isolated
attempts and one controller session per campaign identity. After controller loss,
operators can inspect and terminate owned work, then register a fresh identity.
They cannot resume dispatch under the old identity.

## Source identity

- Worktree: `.worktrees/core-comparison`; branch: `codex/core-comparison`.
- Integrated baseline: `14e13006d9c48fbfa55e74e76c77e1c67e174f46`.
- Task 9 initial source: `33acfd66dbb906ae0e4a77ec3c257143081dafcf`.
- Accepted Task 9 source: `7c693999afda04033b10aaae0ddd19933d891a81`.
- Task 9 base: `401d9f34f71b76ca39204d39badec86eaf30554c`.
- Final reviewed checkpoint/correction base: `0c42cf7728b026b083423ca99e2c48436d02b463`.
- Final correction commits: `31e784b302a1d4245d32e1faa241a38a421f6eaf` and
  `560ebeb1ece1501ddd136db4a74a82219d8bc2bf`.
- Pre-rebase accepted executable/test source: `560ebeb1ece1501ddd136db4a74a82219d8bc2bf`;
  the final plan/spec/validation checkpoint is documentation only.
- Shipped rebased source: `607b78183840de0b8e45b4d5151a76e7f21aca03`.
- Post-push repair source: `a791cbf0` (explicit fixture home), `fd9692e4` (isolated
  test launcher) and `25ff1002031529c6f5588cf9b68b6ca221efa349` (fixture permissions).
- Local runtime: Bun 1.3.14 on macOS. No Docker or remote/installed-appliance
  operation was performed. No existing campaign/results artifacts were migrated.

Task-specific reports, review findings and full logs are retained locally under
`.superpowers/sdd/2026-09-04-core-comparison/`. Task 9's report includes exact deleted
paths, retained responsibilities, replacement/rejection coverage and external test
seams. This record summarizes those receipts; overlapping test groups must not be
added into a unique-test total. The final review, scoped correction review, literal
report oracle and final gate receipts are retained there as Task 10 artifacts.

## Implemented core

| Responsibility | Implementation |
|---|---|
| Work definition | Strict finite experiment/suite, independent campaign UUID and deterministic input digest; primary slots fix planned denominators |
| Execution authority | Atomic journal groups and one fold; one consumed start; private gated controller; exact process/worker identity; durable host claim |
| Admission | Whole-block subject/grader/global demand against frozen pool policy; shared pool/key grants; live resource/fingerprint and telemetry freshness guards; finite attempts/reserves/deadlines; price does not decide inclusion |
| Attempt boundary | Prepared private authority and selected credential registry outside writable output; exact container inspection; independent deadline; publication after proven namespace death |
| Loss and cancellation | Durable cancel intent, full inventory settlement, unknown-state ownership retention; no adoption, replacement controller or continuation |
| Measurement | Immutable accepted observations, positive validity evidence, coherent matched quantities, fixed denominators, determinate per-arm summaries, all-attempt arm/role costs and separate elapsed time |
| Readout | Shared status/cost/report readers; active behavior hidden; immutable provisional snapshots; final canonical report and complete evidence inventory rederived before sealing |
| Operator path | `campaign register/list/status/run/cancel/costs/report`; generic job receipts cannot override campaign authority; four checked configuration examples |

Retired responsibilities include dollar admission/priceability gates, budget amendments,
resumable dispatch/adoption, partial-prefix repair, runtime profile/gating policy,
old campaign process/tmux execution and duplicate generic-job lifecycle authority.
Direct development `run`/`run-all`, Phase 0 corpus/estimates/simulation, runner/checks,
provisioning/adapters/capture/ATIF and shared durable-storage/identity algorithms remain.
Historical artifacts have no runtime compatibility reader in this increment.

## Local verification

| Scope | Source or stage | Recorded result |
|---|---|---|
| Records and execution fold | `16b03af4` | 89 related tests, typecheck and scoped lint |
| Atomic journal and ownership | `4d02be64` | 140 related, 69 additional and 95 affected fix tests; task review and scoped fix review accepted |
| Finite registration/resource policy | `edd5e979` | 245 focused tests; lint, typecheck and scenario validation |
| Bound runtime/deadline | `94000530` | 215 focused and 39 affected fix tests; lint/typecheck; Linux cases unrun |
| Launch/cancellation | `db4668eb` | 265 initial and 65 affected fix tests; lint/typecheck; harmless local processes exercise private gate/identity cuts |
| Session controller/producers | `b8362d43`, scope `c743789f` | 380 initial, 116 timestamp and 68 storage tests; later expanded-group failures retained below |
| Authenticated comparison report | `1c70d4a4` | 250 task and 101 affected fix tests; lint/typecheck; independent arithmetic and rendered named-role inspection; review fixes accepted |
| Operator cutover focused group | `ece04616` | 122 pass, 0 fail, 504 assertions, eight files, 20.49s |
| Full check 1 | Final Task 9 executable source | Lint/typecheck pass; 3388 pass, 13 skip, 1 fail; 19321 assertions; 241 files; 422.83s; exit 1 |
| Full check 2 | Final Task 9 executable source | Lint/typecheck pass; 3388 pass, 13 skip, 1 fail; 19322 assertions; 241 files; 343.55s; exit 1 |
| Full check after review fixes | `7c693999`; `QUORUM_TEST_TRACE_ROOT=/tmp/task9-fix1-full-traces bun run check` | Exit 0; lint/typecheck pass; root 3403 pass, 13 skip, 0 fail; 19387 assertions; 242 files; 349.87s; dashboard 144 pass, 0 fail, 393 assertions, 1.085s |
| Final correction focused group | `31e784b3` | 188 pass, 12 Linux skips, 0 fail; 908 assertions; 13 files; 46.82s; lint/typecheck and 85 scenarios plus registries pass |
| Final fixture correction | `560ebeb1` | 11 report tests pass, 0 fail; 55 assertions; 87ms; regenerated single-arm rendering inspected |
| Final full portable gate | `560ebeb1`; `QUORUM_TEST_TRACE_ROOT=/tmp/task10-fix1-full-traces bun run check` | Exit 0; lint/typecheck pass; root 3423 pass, 13 skip, 0 fail; 19509 assertions; 242 files; 364.85s; dashboard 144 pass, 0 fail, 393 assertions, eight files, 1.088s |
| Separate dashboard check | `cd packages/dashboard && bun run check` | Typecheck and 144 tests pass; 393 assertions; eight files; 1.09s |
| Scenario/config validation | `bun run quorum check` | 85 scenarios plus credentials and arms/suites pass |
| Real local fake CLI smoke | `bun test test/cli-run-superpowers.test.ts -t '^--no-superpowers: provenance null'` | 1 pass, 4 assertions, 2.75s; actual macOS CLI/setup/capture/verdict with fake commands/keys |

Both failed root checks exited before the dashboard stage. The separate dashboard
receipt closes that stage only; it does not make either full check green. Task 9's
initial source at `33acfd66` matches full check 2; temporary diagnostic instrumentation
was restored afterward. Full logs are in `task-9-logs/` beside the task report.

Task 9's full review found one Important preservation gap (missing V2 registration
eligibility/directive tests) and one Minor command-guidance error. The fix adds nine
paired eligibility cases and three real frozen-Git directive registrations, corrects
the campaign report guidance and a stale source comment, and adds opt-in test-only
recurrence evidence. A corrected registration/mock group passed 34 tests and 126
assertions; lint/typecheck passed. Fresh scoped review accepted all fixes with no
new findings. The complete gate at `/tmp/task9-fix1-full-check.log` exited zero on
the exact frozen fix source, with traces rooted at `/tmp/task9-fix1-full-traces`.
Root inspected the final root/dashboard summaries and confirmed the clean worktree.
This closes the required portable gate without establishing the earlier stalls'
causes. No timeout increase or automatic retry was used.

The command journey uses real registration, private gate, controller, journal, claim,
preparation-produced authority/registry, publisher, readers and seal. External worker
effects, host probe and controller time are fake. An internal launch dependency selects
the test fixture while asserting the production target remains fixed. These are useful
portable contracts, not execution of the production container entrypoint on Linux.

## Post-push failure diagnosis and repair — 2026-09-05

The rebased source contained a real integration-fixture mismatch: the brainstorming
scenario setup requires `QUORUM_CODING_AGENT_HOME`, but its direct fixture did not
supply it. Production already forwards that explicit home. Commit `a791cbf0` passes
the fixture's intended home and seeds session evidence under the same path, retaining
all pass/fail/indeterminate assertions.

The local timeouts had a separately reproduced startup cause. The inherited macOS
app temp directory contained 663,800 immediate entries. An empty Bun process took
1,514.73ms beneath that directory, versus 12.65ms from the checkout and 11.61ms beneath
`/tmp`. Enumerating those temp roots took 1,933.37ms and 1.4ms respectively. The pinned
[Bun 1.3.14 resolver](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/resolver/resolver.zig#L2770)
walks ancestor directories during startup. A local package boundary did not avoid
the lookup. These controls establish the reproduced startup slowdown; they do not
retrospectively prove the cause of every older stall.

Root and dashboard checks now use `bun run test`, whose launcher establishes a
private temp root before starting Bun, outside Git checkouts and independent of
inherited app temp variables. Ordinary children inherit the same root. Successful
runs remove their own scratch; failed or cancelled runs retain it and print its
location. Real process tests cover isolation, ordinary child inheritance, sibling
preservation, exit status and handled/default termination. Existing deadlines,
retries, skips and production campaign behavior are unchanged.

Independent review caught handled cancellation returning child exit 0; real SIGTERM
and SIGINT regressions failed before correction and pass afterward. A subsequent
full run passed every root assertion but exposed a lock fixture that left a renamed
directory read-only. Its teardown now restores permissions after the unchanged
failure and heartbeat assertions. Both corrections received scoped review acceptance.

| Receipt | Result |
|---|---|
| Rebased local gate, `607b7818` | 3479 pass, 14 skip, 5 fail; 463.81s; four timeouts and the missing-home fixture; dashboard not reached |
| [Linux CI on `607b7818`](https://github.com/prime-radiant-inc/superpowers-evals/actions/runs/33950144902) | 3483 pass, 14 skip, 1 fail; only the missing-home fixture failed |
| Diagnostic full gate after home correction, `a791cbf0` | 3476 pass, 14 skip, 8 subprocess timeouts; 517.01s; dashboard not reached |
| First isolated-temp full gate, `fd9692e4` | Root 3489 pass, 14 skip, 0 fail, 19676 assertions, 177.38s; wrapper exit 1 on fixture permission cleanup; dashboard not reached |
| Final standard full gate, `25ff1002` | Exit 0; lint and both typechecks pass; root 3489 pass, 14 skip, 0 fail, 19676 assertions, 178.73s; dashboard 144 pass, 0 fail, 393 assertions, 1.08s |
| Separate scenario validation | 86 scenarios, credentials and arms/suites pass |

The final command was `QUORUM_TEST_TRACE_ROOT=/tmp/core-temp-fixed-full-traces bun run check`,
on clean, frozen `25ff1002`. Full logs, failing receipts, timing controls, scoped
reviews, traces and SHA-256 manifests are retained under the task evidence directory's
`failure-debugging/` subdirectory. This is portable source/test evidence. Appliance
execution, installed runtime behavior and native Windows test launching remain
separate qualification work.

## Final review and architectural judgment

Keep this foundation. The retained runner, checks, provisioning and capture remain
the useful execution substrate. One atomic execution history, finite controller and
common report fold replace competing campaign lifecycle paths. Frozen public inputs,
private attempt authority, ownership records and published evidence have distinct
responsibilities; collapsing them would recreate ambiguity about who may launch
work and which outcomes belong in a comparison. This is a sound evolution, not a
promise that no further implementation increment will be needed.

The final cross-cutting review covered the integrated baseline through `0c42cf77`
and found four Important defects and one Minor fixture defect, with no Critical
finding. Its corrections are local to the intended boundaries:

| Finding | Accepted correction and meaningful check |
|---|---|
| An early report occupied immutable final filenames and blocked later publication | Eligible provisional reports use `report-snapshots/<last_sequence>-<report_digest>/`; final filenames remain available for a completed, complete, termination-verified seal. Public command tests cover loss/report/cancel/report and ended/report/termination/seal while preserving earlier bytes. |
| Retained host checks had lost their admission callers | Live resource floors and frozen/live hardware fingerprint comparison run before admission; freshness is checked after slow preparation and at create/start boundaries. Controller tests refuse changed hardware, below-floor resources and stale telemetry, while cleanup remains authorized. |
| Credential aliases sharing a quota pool could overuse one key | Current and prospective grants share `(logical pool, public key env)` loads. Registration permits reordered or overlapping inventories with consistent derived key limits and rejects contradictory limits. Actual concurrent grants in the four-alias case stay at two per key. |
| Reports lacked required per-arm summaries, arm accounting and campaign elapsed time | The existing fold/schema/renderer now provide determinate rates, independent complete-value means/counts, every attempt's arm accounting and start-claim-to-ended elapsed time. Existing matched cohorts remain unchanged. |
| The Linux fixture expected a retired journal event | It now checks V2 `runtime_bound` identities and runtime-spec digests against the projection; execution remains unrun on Linux. |

Root's independent arithmetic/render inspection found one additional Minor fixture
annotation error: a valid synthetic publication retained its inherited missing-
publication reason. The one-line fixture correction clears that reason while
preserving partial cost and independent token missingness. The single-arm oracle
has a determinate pass rate of 1/2, subject cost mean 5 across two samples, grader
cost mean 1 across one complete sample, all-attempt subject cost 110 and known grader
cost 10.5 with only two of three grader costs complete. Campaign elapsed is 24 seconds;
overlapping attempt wall times total 40 seconds. Literal arithmetic was computed
independently of the production fold and both generated Markdown fixtures inspected.

Fresh scoped review accepted all six corrections with no new Critical, Important or
Minor finding. The final full gate then ran on clean, frozen `560ebeb1` and exited
zero; no source or HEAD change occurred during it. Its original log is
`/tmp/task10-fix1-full-check.log`, with external traces under
`/tmp/task10-fix1-full-traces`. Copies, 24 trace files and a SHA-256 receipt are retained
in `task-10-fix-1-logs/` under the local task evidence directory. Log SHA-256:
`bbb639ea03cfdbcc5b5dfe327c437276e1d5b4c87f3259d63ff1f3a4a5c7784d`.

This closes local code/review acceptance. Supported refs, harnesses, model/endpoint
credentials and skill presence are configuration inputs; single-arm and matched
reports no longer require a separate extractor. The remaining usability and same-
workday speed claims need the operational measurements below. Resume/restart and
coordinated subject error reporting remain deferred by Drew.

## Negative results and unresolved failures

- The integrated baseline full check had 3675 pass, 6 skip and one CLI timeout
  (5428ms against 5s). Later isolated passes did not establish its cause.
- Task 7's expanded six-file group had 99 pass and two timeouts: Claude environment
  projection at 62.68s against 5s, and Copilot grader contract at 10.34s against 10s.
  Both cases passed in both Task 9 full runs. Their earlier causes remain unknown.
- Task 9 full check 1 timed out the CLI fail-verdict/run-id case at 9083.15ms against
  5s. The retained run reached agent phase, had no mock result tree and wrote a stopped
  verdict after SIGINT. Ten instrumented focused passes did not reproduce the delay.
  A separate staff source/artifact review found that four seconds of empty-capture
  retries after interruption could explain the extra duration. This is a timing
  inference, not a trace or cause of the original deadline miss.
- Task 9 full check 2 timed out archived-tree exact-SHA recovery at 5734.11ms against
  5s. Ten focused runs passed; all 170 timed Git calls exited zero, slowest 33.62ms.
  No failure-time stall was reproduced. The CLI case passed in this full run.
- A separate early command journey stalled at registered/started/controller-bound
  while waiting for report (~16.08s). No fixture-controller error or child exit status
  was retained. Temporary inherited-stderr diagnostics and ten passes did not prove
  a cause. This is separate from the CLI and Git timeouts.
- During the fix's first affected group, a new frozen-directive registration timed
  out at 5586.97ms against 5s. Bun killed one dangling process; materialization's
  `bun install --frozen-lockfile` returned status null with empty stderr. The old
  frozen-directive case also used the default timeout, so no explicit allowance was
  lost. After correcting a separate CSV fixture mistake, three traced registrations
  passed at roughly one second each. No install/network/provider/OS cause or repair
  is established. Test-local registration command spans now preserve recurrence
  evidence, alongside CLI mock markers and Git call spans.

No timeout increase, automatic test retry or production retry workaround was added.
A later host snapshot showed available CPU and memory; it cannot establish resource
conditions at the failures. Another passing retry alone would not prove a repair.
The next reproducing CLI diagnostic should retain run-only invoke/shell/Bun/stop/close
and capture timing without environment, credentials, argv or transcript dumps. The
same shim also serves provenance `--version`, which must be distinguished from `run`.

Concrete Task 9 integration defects did receive regressions and corrections:

- Read-only SQLite opens hit `SQLITE_BUSY` during a real controller write. A bounded
  one-second read busy handler now has real concurrent-writer short/over-bound
  RED/GREEN coverage. Writer/admission waits remain zero.
- A missing configured results directory was a fixture defect; creating it did not
  weaken publisher storage-error handling.
- Alias-local key capacity could exceed the frozen aggregate pool policy. Selection
  consumes the aggregate capacity, with least-load/tie/exhaustion coverage retained.
  The final review additionally found the separate alias-local load-accounting gap;
  the shared pool/key correction above closes that gap.

The final correction round also exposed test-fixture mistakes. Adding the live
preflight probe advanced a fake clock twice and made missing telemetry overlap
zero-duration attempts; the fixture now keeps preflight sampling instantaneous,
without relaxing production validity. A new alias regression initially lacked
required frozen refs. Both fixtures were corrected before their covering green
receipts. A Bun matcher type mismatch was corrected with a direct byte-equality
assertion. These explained failures do not explain any historical subprocess stall.

Immediate cancellation after exact controller death still refuses a fresh live-spend
lease until its 150-second stale threshold. The portable test first asserts refusal,
then ages only the dead temporary holder's lease timestamps to exercise canonical
cancellation. This simulates elapsed time; it is not a measured recovery duration.

## Configuration interpretation

The [comparison guide](../campaign-comparisons.md) explains PR/base, skill/stock,
model/model and Claude/Codex examples. The harness example changes model and endpoint
as well as harness, so its result is a complete-stack comparison, not an isolated
harness effect. Ref placeholders require actual committed objects in the configured
source checkout.

Active suites use direct Anthropic `sonnet5` grading because existing Mantle subject
and grader presets select the same bearer variable; genuine preparation rejects
equal subject/grader secret values. Separately keyed Mantle grading remains expressible
through the existing credential contract. The direct route differs from historical
grading, so numerical continuity is not claimed. Declared caps of two for `sonnet5`
and one for `kimi_k3` are conservative configuration limits, not measured provider
quotas or same-workday throughput evidence.

## Outstanding operational gates

The Linux fixture is converted and typechecked but unrun. It retains five full-runner
fake-provider behaviors: scoped complete attempts, daemonized subject cleanup, stopped
verdict after TERM, logs/death after SIGKILL, and parallel tmux paths with distinct
backing mounts/namespaces. Seven separate harmless runtime probes exercise deadline,
binding and uncertain-client cuts; they do not alone prove the real runner boundary.

After separate authorization, use an explicitly selected actual Linux amd64 host,
Docker, the final committed evals source, Bun at the repository floor, and a selected
pinned Gauntlet checkout. The fixture requires the canonical image ID to match
`superpowers-evals:local`. Fixture source and types were checked through `560ebeb1`;
all 12 Linux cases were skipped in the focused macOS receipt. No host or digest has
been selected or built here.

```sh
scripts/evals-container --gauntlet-root /absolute/path/to/pinned/gauntlet build
QUORUM_DOCKER_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' superpowers-evals:local)" \
  QUORUM_DOCKER_INTEGRATION=1 \
  bun test test/linux/campaign-attempt-docker.test.ts
```

Record actual evals/Gauntlet revisions, image ID, host/kernel, exact commands, full
logs and exit codes. The fixture supplies fake provider/subject/grader material; it
does not require a real provider key. Docker Desktop is not a substitute for this
Linux gate.

Installed-helper proof, a separately authorized small paid comparison, and a timed
maintainer exercise from blank editor to accepted registration remain separate. The
usability target is under 30 minutes, with environment setup recorded separately.
Do not retire the old appliance or migrate artifacts as part of this coding task.
Neither portable tests nor historical sentinel results establish eight-hour workload
or same-workday readiness.

# Core comparison implementation and validation

**Date:** 2026-09-04

**Tracking:** [PRI-2874](https://linear.app/prime-radiant/issue/PRI-2874/quorum-overhaul-campaign-platform-comparative-evals-as-configuration)

**Status:** Tasks 1–9 implemented and reviewed; full portable gate passed. The final
cross-cutting staff review is pending. Linux, installed-appliance, paid comparison
and timed usability checks remain unperformed.

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
- Local runtime: Bun 1.3.14 on macOS. No Docker, remote or installed-appliance
  operation was performed. No existing campaign/results artifacts were migrated.

Task-specific reports, review findings and full logs are retained locally under
`.superpowers/sdd/2026-09-04-core-comparison/`. Task 9's report includes exact deleted
paths, retained responsibilities, replacement/rejection coverage and external test
seams. This record summarizes those receipts; overlapping test groups must not be
added into a unique-test total. Final cross-cutting review remains pending.

## Implemented core

| Responsibility | Implementation |
|---|---|
| Work definition | Strict finite experiment/suite, independent campaign UUID and deterministic input digest; primary slots fix planned denominators |
| Execution authority | Atomic journal groups and one fold; one consumed start; private gated controller; exact process/worker identity; durable host claim |
| Admission | Whole-block subject/grader/global demand against frozen pool policy; finite attempts/reserves/deadlines; price does not decide inclusion |
| Attempt boundary | Prepared private authority and selected credential registry outside writable output; exact container inspection; independent deadline; publication after proven namespace death |
| Loss and cancellation | Durable cancel intent, full inventory settlement, unknown-state ownership retention; no adoption, replacement controller or continuation |
| Measurement | Immutable accepted observations, positive validity evidence, coherent matched quantities, fixed denominators and separate all-attempt role costs/missingness |
| Readout | Shared status/cost/report readers; active behavior hidden; canonical report and complete evidence inventory rederived before sealing |
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
  now consumes the aggregate capacity, with least-load/tie/exhaustion coverage retained.

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
`superpowers-evals:local`. Source was checked at `33acfd66`; no host or digest has
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

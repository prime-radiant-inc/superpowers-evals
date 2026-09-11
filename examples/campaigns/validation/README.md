# Frozen validation workloads

These versioned Suite V2 templates declare repeatable comparisons. They are not
launch authorization. Supply the symbolic `baseline` and `candidate` arms at
registration; no comparison-specific arm files belong here.

| Input | Frozen selection |
| --- | --- |
| Baseline | `v6.3.0`, peeled commit `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Candidate | `dev`, commit `3a8bdc11e1db42955350d6d6f063f7a8e89aef58` |
| Claude | `claude:opus_bedrock`, Opus 4.8 through the provisioned route |
| Codex | `codex:openai_responses_56sol`, gpt-5.6-sol |
| Pi | `pi:pi_gpt56_sol`, gpt-5.6-sol |
| Gauntlet-Agent, both roles | `sonnet5`, `claude-sonnet-5`, direct Anthropic |
| Effort | No runtime override; record effective harness settings and provider defaults at registration |
| OS | Linux, existing scenario/adapter/credential eligibility |
| Replacements | Zero reserves, one attempt; retain invalid samples |
| Admission | Existing paired admission, maximum exposure skew 60 |
| Capacity target | Eight global attempts; grader pool eight only after Task 9 verifies capacity |
| Implementation identity | Freeze final evals/Gauntlet commits and image digest at registration |

`focused.yaml` covers the first seven declared scenarios on Claude and Codex,
three repetitions on both revisions: **84 primary samples**, a **four-hour**
target from durable execution acceptance to a usable report, and a 5400-second
outer attempt bound. `release.yaml` covers all 22 scenarios on the three
pairings, with three repetitions except five for `sdd-go-fractals-opus48`:
**366 primary samples** (Claude 136, Codex 136, Pi 94), a **24-hour** target,
and a 10800-second outer bound. These are targets, not measured throughput.

Pi is excluded from exactly these seven release scenarios by their existing
eligibility: `user-pref-no-brainstorm`, `conversation-design`,
`worktree-no-drift-to-main`, `tdd-holds-under-tests-later-pressure`,
`conversation-review-feedback`, `conversation-config-repair`, and
`conversation-debugging`. Any additional exclusion misses declared coverage.

The exact subject/fused-QA allowances are in `requirements.json`. An absent
scenario allowance resolves to the frozen agent's existing ten-minute default.
Do not consume spare outer time by increasing those allowances. Reserve 15
minutes for setup/capture/checks/publication/cleanup and account for the existing
legacy QA final-turn allowance when validating bounds. Conversation assessment
totals are ten minutes for design, code-review and review-feedback; five minutes
for pricing, config-repair, debugging and verification. Each total includes 60
seconds of report grace and five seconds of publication reserve. These budgets
are engineering declarations, not measurements of optimal limits.

The committed pricing snapshot reference is retained verbatim. Its rate date is
not claimed current; Task 9 must verify coverage. Missing prices leave costs
unknown rather than zero and do not erase behavioral measurement.

## Requirements data contract

`requirements.json` is frozen data for report verification, not a new executable
suite or runtime service. Its SHA-256 must travel with the chosen template.
`scenarios` maps names to `mode` (`qa` or `conversation`), source hashes,
allowances, eligibility, oracle authority and `criteria` objects:

- `id`: stable `<scenario>:<ordinal>` obligation ID.
- `ordinal`: one-based acceptance-criterion position in the story.
- `text`: the existing criterion text, joining its wrapped lines with spaces.
- `required_artifact_classes`: unconditional evidence needed to judge this obligation.
- `check_refs`: explicit `{ordinal, scope}` references into the scenario's `checks` array; an empty array means no executable check establishes the obligation.

The scenario-wide `required_artifact_classes` is the union of its criterion
requirements. The deliberately small vocabulary is:

| Class | Meaning |
| --- | --- |
| `native_session` | Coding-Agent native session evidence, including tool invocations and outcomes |
| `normalized_trace` | The corresponding normalized trajectory for ordering and process claims |
| `visible_delivery` | Complete user-visible interaction and delivered response or explicitly delivered report |
| `output` | Preserved supplied source and final delivered files relevant to the obligation |
| `check_dispositions` | Structured executable-check records and their trusted oracle results |

An executable output obligation uses check evidence independently of trajectory
availability. Static code-review grounding unconditionally requires only complete
`visible_delivery` and supplied `output` (including before/current source).
Missing or corrupt process capture does not make a source-only grounding judgment
unavailable. Supplied source can establish development history such as the query
regression without a process trace. Claims of execution or other history not
established by supplied source still require supporting context under the existing
assessor grounding/limitations obligation. The consumer must not promote those
conditional needs into unconditional capture dependencies: the assessor judges
unsupported claims against the unchanged rubric. This declaration introduces no
per-claim parser, condition evaluator or additional judge. Actual process criteria
continue to require process evidence.

Each scenario's `checks` array enumerates the exact manifest entries as
`{ordinal, phase, check, args, negated, count, authority}`. Ordinals are zero-based
positions in the existing manifest's `entries` array. Preserve `args: null` as the
manifest's dynamic-argument identity; do not fabricate resolved commands. Keep
multiplicity `count` intact. `authority` identifies a kind (`precondition`,
`process_check`, `output_check`, `source_preservation`, or `independent_behavior`)
and the existing source files implementing that check. `oracle_authority` retains
the manifest identity/hash and source pointers; no new oracle is introduced.

Criterion `check_refs` explicitly state the limited part of each obligation the
referenced check supports. The consumer must not infer missing associations from
text or treat a check as establishing more than its declared scope. For example,
configuration repair criterion 2 references the independent behavior oracle;
its process/history criteria do not. Code-review criteria have no check refs:
source preservation does not prove prose findings or grounding. Composite oracle
success supports its listed behavior checks; composite failure alone does not
identify which individual behavior failed. Preserve the check disposition and
let the existing assessment account for that limitation. Evidence presence is
not a passing judgment.

`story_sha256` hashes the exact story bytes. For conversation mode,
`rubric_sha256` hashes the existing `projectConversationStory(story).rubric`;
for fused QA it hashes the complete story presented to the Gauntlet-Agent.
`check_manifest_sha256` hashes the exact existing check-manifest bytes. A source
change requires explicit re-freezing of affected inputs, not silent refresh.
The YAML's `grader` is parsed separately using the existing `GraderSchema`, as
registration already does, and the remaining fields use `SuiteSchema`.

Require truthful dispositions for all 84/366 primary samples, every declared
repetition, required judgments/checks/capture and authenticated source identity.
Report actor-specific cost coverage separately. Small-sample descriptive deltas
do not establish equivalence, and these reports make no automatic release decision.

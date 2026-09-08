# Conversation and assessment appliance pilot

Status: completed the six attempts authorized by Drew ("lgtm, let it rip").
All six completed delivery, passed assessment and the independent oracle, and
published usable evidence with complete costs. No retries or replacement runs.

## Question and fixed inputs

Does the new user/assessor split produce a natural coding-harness interaction,
independent grading grounded in retained output/transcript, and a usable standard
report? Can two copies per harness overlap without interference?

The implementation is Quorum d52b36be and Gauntlet
74d2037aed14f413db482b7635783e4e0498c316. This pilot adds only committed arm/suite
declarations and this experiment record. Superpowers main resolved to
b36e0829c6d0140e93cfef2ca599b1b07d4a7797; all six attempts use that exact revision and
high subject effort. The source snapshot records the final declaration commit.

| Role | Credential | Model |
|---|---|---|
| Claude subject | opus5_bedrock | anthropic.claude-opus-5 |
| Codex subject | openai_responses_56sol | gpt-5.6-sol |
| User and assessor | sonnet5_bedrock | anthropic.claude-sonnet-5 |

Use the existing committed September 6 pricing snapshot, SHA-256
6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b. These are estimated usage prices, not a
provider invoice. Retain unknown/missing cost coverage explicitly.

## Execution and stop conditions

1. Register suites/conversation_claude.yaml at cap 1, run once and inspect it.
2. If operationally valid and useful, register suites/conversation_codex.yaml at
   cap 1, run once and inspect it.
3. If both paths are useful and valid, register suites/conversation_parallel.yaml
   at cap 4: two fresh attempts per harness, four total.

Each attempt has a ten-minute conversation bound, two-minute assessment bound
and fifteen-minute outer deadline. Every suite uses reserve 0 and max_attempts 1.
There are six authorized attempts and no automatic retries/replacements.
A completed bad implementation or refusal remains a behavioral result.

Approved spend allocation is $40: $10 for the first two runs and $30 for the
four overlapping runs. Poll the installed helper's status/costs and cancel on
instrument failure, missing endpoint/evidence, wrong model routing, unusable
role behavior, lost started-role usage or allocation exhaustion. The allocation
is an operator stop rule, not a hard provider-billing ceiling.

Use an isolated installed copy of the existing appliance helper with the
canonical host-wide live-spend lock and existing blessed credential bundle.
Use the existing immutable runtime image and campaign source snapshots; leave
canonical source checkouts and the base container unchanged. No GitHub push,
new provider credential system, scheduler or campaign-policy change is required.

## Results

All registrations use Quorum source fa2f6e885276d414c35f8b3dbb1468228a115d6a
(the reviewed runtime plus committed pilot declarations), Gauntlet
74d2037aed14f413db482b7635783e4e0498c316 and the Superpowers SHA above.
The existing Linux image has Bun 1.3.14, Claude Code 2.1.209 and Codex 0.146.0.

Preparation initially failed the source check because the host's group-writable
umask produced 100664 instead of the required 100644 on two existing pinned
serf fixture files. Correcting those checkout modes and creating subsequent
snapshots under umask 022 made source validation pass. No runtime source was
changed, no checks were bypassed, and no model call preceded that correction.
The canonical checkouts and base container remained unchanged.

### Inspected Claude run

Campaign e3bdd1a7-0aa3-4bcd-b500-3eeecf7219c0; attempt
c1:conversation-pricing:conversation_claude:r1:a1; published run
conversation-pricing-claude-opus5_bedrock-linux-20260908T022605Z-d705.

Completed delivery, final pass, both criteria pass and the independent pricing
oracle passes. Worker duration 206.564 seconds; campaign elapsed 219.447 seconds.
Estimated subject cost $0.69808125; simulated user $0.4627209; assessor
$0.0640583; combined campaign estimate $1.22486025. All started usage is present,
with no unpriced models and termination/publication verified.

Manual inspection of retained captures 020/021/022/052, exchange, output and
native bootstrap agrees with the grade. The user actor navigated the actual
question UI, chose full price for unknown codes, and answered the empty-code
follow-up without edit instructions. The delivered Object.hasOwn lookup preserves
known discounts and uses zero discount for other codes. The final delivery cites
verification; the independent oracle passed separately.

The native log contains Superpowers SessionStart context, including the
using-superpowers content. No later Skill tool call was recorded. Availability
and invocation are distinct; this rubric deliberately does not require a skill.

### Inspected Codex run

Campaign 75939f6e-31bf-4e85-a3f1-31291214cb78; attempt
c1:conversation-pricing:conversation_codex:r1:a1; published run
conversation-pricing-codex-openai_responses_56sol-linux-20260908T023457Z-508e.

Completed delivery, final pass, both criteria and oracle pass. Worker duration
343.293 seconds; campaign elapsed 356.214 seconds. Subject cost $0.725021,
simulated user $0.5827657, assessor $0.3117045; campaign combined estimate
$1.619491. Complete usage, valid publication, verified termination.

The actor sent the opening, answered the subject's unknown-code policy question,
and approved its design. It did not dictate code. The output uses an own-property
lookup with zero fallback; tests cover all three known codes, an unknown string
and constructor. Root and an independent reviewer inspected this evidence.
Superpowers was available and the native transcript shows actual skill reads.

The lead used gpt-5.6-sol at high effort. It explicitly chose gpt-5.6-terra at
medium effort for an independent code review; both native sessions and their
costs were captured ($0.6566576 Sol, $0.0683634 Terra). This is observed harness
behavior, not silent routing drift. It also means this is not a pure single-model
measurement. The assessor slightly misdescribed an intermediate test count:
step 31 had one passing test, and the final step 49 had two. The final grade is
supported despite that citation imprecision.

### Overlapping phase

The first two attempts consumed an estimated $2.84435125 of their $10 allocation.
Both inspected gates passed. Campaign 4b68dac8-3349-4830-a1c0-9c808a69bc66
registered and completed two fresh attempts per harness at cap 4; the four-run
allocation was $30. Source pins match the inspected single runs.

| Attempt | Run suffix (20260908) | Worker seconds | Estimated total USD |
|---|---|---:|---:|
| Claude r1 | T024635Z-b76f | 194.777 | 1.162554 |
| Claude r2 | T024637Z-cb85 | 196.959 | 1.031457 |
| Codex r1 | T024636Z-990a | 208.888 | 1.010264 |
| Codex r2 | T024638Z-86dc | 301.619 | 1.561512 |

Published basenames use conversation-pricing-claude-opus5_bedrock-linux- or
conversation-pricing-codex-openai_responses_56sol-linux-, followed by the date
and suffix above. Attempt IDs use c1 for Claude and c2 for Codex, the scenario
and arm names, r1/r2, then a1.

All four have final pass, both criteria pass, a passing independent oracle,
publication_valid true, analysis_usable true, no missingness, and complete
subject/user/assessor cost coverage. Both role processes exited zero. The
campaign completed with termination_verified true and no retry, stop or error.

The four conversation intervals began at 02:46:35.517, 02:46:36.544,
02:46:37.521 and 02:46:38.576 UTC on September 8. The earliest finished at
02:49:26.339. Their common overlap was **167.763 seconds**, establishing actual
concurrency both within each harness and across harnesses. The campaign elapsed
**318.312 seconds** (02:46:33.714–02:51:52.026); summed worker time was
902.243 seconds. This is direct overlap evidence, not an old/new speedup estimate.

The Claude outputs used two different valid fallback implementations. Both
Codex leads used Sol and explicitly selected Terra review subagents; all native
sessions and costs are retained. Codex r2's reviewer caught a prototype-property
edge case, which the lead fixed before delivery. Native evidence in every run
confirms Superpowers availability. Each assessment started after its own
conversation ended and took 16.692–23.260 seconds in this phase.

### Pilot outcome, limits and next evidence

| Phase | Attempts | Usable passes | Campaign seconds | Estimated total USD |
|---|---:|---:|---:|---:|
| Inspected Claude | 1 | 1 | 219.447 | 1.22486025 |
| Inspected Codex | 1 | 1 | 356.214 | 1.61949100 |
| Parallel Claude/Codex | 4 | 4 | 318.312 | 4.76578705 |
| Total | 6 | 6 | — | **7.61013830** |

Subject cost totals $4.1138703, simulated-user cost $2.910347, and assessment
cost $0.5859211. The last decimal differs from the campaign total by role-total
rounding. All amounts use the frozen pricing snapshot; none is an invoice.

The useful result is one working prose-to-real-harness conversation, retained
output/transcript, trusted check and independent standard assessment path on
Linux Claude/Codex, with four overlapping workers. No observed instrument
failure required a runtime fix during this pilot. The appliance owned execution
between polls. After completion only the preexisting base container remained;
the shared spend lock was absent and canonical checkouts were clean at their
original revisions. The isolated pilot checkouts and artifacts remain available.

This does not prove spontaneous clarification (the brief explicitly requests
it), a live bad delivery/refusal, a wider scenario catalog, every supported
harness/provider/platform, sustained high concurrency, or a performance gain.
There is no old/new or Superpowers treatment comparison. The Codex observations
include its chosen secondary model. The independent assessor is useful but not
an exact citation engine: the inspected single Codex run had a minor intermediate
test-count error, and both parallel Codex assessments called the user's opening
the agent's prompt. Parallel Codex r2 also loosely called subject-written tests
the trusted pricing check. Its separately retained oracle result supplies the
required independent evidence. Those defects do not overturn the independently
inspected final result. The independent reviewer checked all four parallel
exchanges, actual native questions, final verification and oracle records, and
found no unsupported pass or premature delivery cutoff. The grader's evidence
attribution is less precise than the underlying retained evidence.
Claude parallel r1 also asked whether to add tests, and the actor selected
"No, just the fix" from its options (captures 020–022). The rubric permits that
choice and visible ad hoc verification passed, but the absence of a test file
is user-directed. Unspecified user preferences introduce additional process and
cost variation, so these runs cannot support a controlled comparison of testing
behavior or skill use.

The smallest next separately approved proof is a conversation-mode variant of
code-review-catches-planted-bugs, reusing its fixture on these two harnesses.
That exercises a delivered review against known defects rather than another
executable pricing fix. Keep the user brief free of grading instructions. No
new runner, scheduler, service, general interface, broad migration, or additional
paid attempt is part of this completed pilot.

### Evidence locations

The appliance root is /srv/quorum/pilots/conversation-assessment. Canonical
campaign records and standard report.json/report.md are under
superpowers-evals/campaigns/<campaign-id>-<suite-name>/; published per-run
evidence is under results/<published-basename>/. Helper operation receipts are
under receipts/. Exact campaign IDs are recorded above. These remote artifacts
include sensitive native transcripts and should remain on the trusted appliance.

Selected standard reports and per-run verdict/conversation/role JSON were copied
to ignored local results/conversation-assessment-pilot/{claude,codex,parallel}/.
The generated reports are unmodified; the Markdown experiment record contains
the bounded manual inspection notes. No raw transcript or credential HOME was
added to Git. Runtime branches remain unmerged and unpushed.

### Accounting limitations

The campaign cost view publishes observed amounts after attempt publication.
An active zero subtotal with observed 0 and complete false is unknown, not free.
The existing estimateUsageSidecar function can price live role usage as an
interim operator view; unfinished subject cost remains unknown until capture.
The final figures above come from completed standard campaign reports, not
that interim view. Standalone verdict source-version fields are still null;
exact source identity is in the frozen campaign refs and source mounts, not
those absent fields. No inference about general model quality or throughput
is justified by this one scenario.

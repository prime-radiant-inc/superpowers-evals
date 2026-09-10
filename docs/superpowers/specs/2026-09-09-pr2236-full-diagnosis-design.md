# PR 2236: full diagnosis pilot

**Status:** Offline preparation in progress after the initial design review with
Drew on 2026-09-09. Fixture eligibility was refined during preparation as
documented below.
This specifies the next experiment; it does not schedule live runs or extend
the discovery pilot's spending allowance.
**Date:** 2026-09-09.
**Subject:** [Superpowers PR 2236](https://github.com/obra/superpowers/pull/2236).
**Implementation plan:** [Preparation, qualification, and six-run execution](../plans/2026-09-09-pr2236-full-diagnosis.md).
**Prerequisite evidence:** [Discovery recommendation and latest follow-up](../../experiments/2026-09-09-pr2236-claude-absolute-path.md),
[original comparison](../../experiments/2026-09-09-pr2236-session-discovery.md),
and [Pi follow-up and ATIF repair](../../experiments/2026-09-09-pr2236-pi-followup.md).

## Question and scope

Can Claude, Codex, and Pi each locate a past session, run all seven diagnosis
analysts, and produce a correct, evidence-backed local report, both before and
after replacing the per-harness session references with shared discovery?

The discovery pilot established positive examples of finding and interpreting
an ordinary remembered session. It did not exercise analyst delegation or a
diagnosis report. This pilot tests whether the discovered paths and record
meanings remain useful throughout that workflow, particularly for human-message
attribution, associated sessions, and token/time accounting.

Use **six top-level runs**: one before/after pair per harness, one incident per
pair, no repetitions or reserve. Each run must dispatch all seven analysts:
**42 expected analyst invocations**, in addition to the six diagnosis controllers
and their Gauntlet-Agents. Six runs is not six model calls. Preserve and account
for unexpected extra work too.

The measured workflow is problem intake → locate → seven analysts → local
report. GitHub searches and publication, export/redaction, similar-session
searches, implicit triggering, current-session diagnosis, and large or damaged
history stress cases are separate follow-ups. This is a small end-to-end
example on each harness, not a reliability estimate or validation of every PR
branch.

## Approach

Use one real, compact historical incident per harness and grade the complete
workflow against a private, independently checked answer key. This is the
recommended approach: it tests the handoff from discovery to analysts while
keeping the initial live comparison small.

Replaying the existing discovery fixtures would be cheaper to prepare, but
their simple file-writing task provides little evidence for plan, quality,
repetition, or associated-session findings. Testing the analysts only against
a supplied case file would isolate interpretation, but skip the discovery
handoff this change introduces. Neither is an additional live arm. Supplied
cases and deliberately flawed reports are useful offline checker tests.

## Frozen comparison

| Harness | Before | After | Samples |
|---|---|---|---|
| Claude | Original PR skill and its three session references | Latest shared-discovery skill | 1 per arm |
| Codex | Original PR skill and its three session references | Latest shared-discovery skill | 1 per arm |
| Pi | Original PR skill, including `other-harnesses.md` | Latest shared-discovery skill | 1 per arm |

The before source is `801badbf719f4044c97175e5b01fb6f7cbc32c2d`; the after
source is `3f0a63e860d4719397e584e90cc7af07a247cb6d`, including the verified
absolute-path wording. These are the PR head and its shared-discovery
derivative, not the PR base branch. Reuse the corresponding runtime packages
`d7bc5b0197d3f5358d8af03d4474ec3c826465be` and
`6ac8f0c0c9e256a619736388fd5c0b85c35c39a1` after checking their manifests.

Both packages exclude development docs, tests, and Git history under the same
policy. The after arm must not see copies of the deleted references through
development plans, source history, or another installed plugin. Genuine harness
documentation remains available. Record both source and installed-package
identities; an unavailable installed Git SHA is not permission to invent one.

Reuse the discovery pilot's model selections:

| Actor | Credential | Model | Effort |
|---|---|---|---|
| Claude Coding-Agent | `opus_bedrock` | `anthropic.claude-opus-4-8` | high |
| Codex Coding-Agent | `openai_responses_56sol` | `gpt-5.6-sol` | high |
| Pi Coding-Agent | `pi_gpt56_sol` | `gpt-5.6-sol` | no override; verify effective setting |
| Gauntlet-Agent | `sonnet5` | `claude-sonnet-5` | existing supported configuration |

Pin the Evals and Gauntlet commits, container digest, CLI and extension versions,
provider routes, tools, native subagent configuration, and effective settings
in the launch manifest. Do not assume analysts inherit the parent's model:
inspect the pinned harness configuration, use the parent model where supported,
and freeze the same selection policy in both arms. Record actual child models
and any deviations. No cheaper analyst tier is introduced by this experiment.

Within each pair, use identical fixture bytes, public request, neutral answers,
and limits in fresh homes and sessions. Keep before/after starts adjacent under
the finite campaign's exposure checks; record actual ordering and start skew.
Compare arms within each harness. Different native incidents and models do not
support a ranking across harnesses.

## Historical incident contract

Select retained native histories before generating anything new. Each harness's
fixture contains one target root, one discoverably linked historical child, and
two plausible unrelated root decoys. Prefer three to eight real human prompts
and at most forty executed tool calls across root and child. A complete task
with two real human prompts is acceptable when it covers the evidence below;
do not add prompts or retain unrelated work to reach the preferred count.
Choose a completed, self-contained task whose inputs and relevant artifacts can
be retained without access to its original machine.

**Preparation refinement (controller decision, 2026-09-09):** The initial draft
required an agent deviation in every target. Corpus inspection found useful
clean sessions, as well as a compact Claude repair with failed test commands
and recovery. Admitting those clean sessions tests whether the diagnosis avoids
fabricating faults. A complete two-prompt repair also preserves real evidence
without padding the conversation. The six-run comparison and seven required
dimensions remain the same; corpus qualification is still required before launch.

The incident must provide:

- An agreed course of work and observable execution that can answer the user's
  concern. A direct request can establish the course; a proposed design needs
  its actual approval. A concern about repeated testing may prove justified
  work rather than a deviation. Include clean incidents as negative controls;
  do not require or invent an agent mistake in every harness's history.
- A skill read or invocation, a real tool action/result pair, and a real stumble
  or repeated action. Record which occurred; do not manufacture every failure
  category in every fixture.
- A historical child dispatch and its transcript, plus enough provenance to
  distinguish human requests from injected text and the parent's child prompt.
- Native usage and timestamp evidence sufficient to check at least one turn's
  tokens and elapsed time, and an explicit inventory of available child metrics.
- At least one negative control: for example, a justified reread after an edit,
  a legitimate test rerun, or a dimension with no conflict or deviation.

Use an actual writing-plans output if a plan file is involved. Preserve the
native trace and associated plan/artifact provenance, following the
[fixture-methodology finding](../../experiments/2026-06-10-sdd-cost-experiments.md).
Do not hand-write an idealized plan or reverse-serialize invented ATIF events
into a purported native session. A bounded excerpt must retain the complete
selected task and the records needed to interpret counters, identities, and
relationships. Record truncation and make omitted context explicit.

Sanitization and path relocation must be documented transformations, preserving
relationships and the evidence being measured. Recompute line locators and
hashes after transformation. Do not insert giant records or malformed tails in
this first pilot; record actual sizes and longest records.

Fixture qualification produces a manifest of exact files, hashes, identities,
recorded harness versions, transformations, expected capabilities, and the
public request. It also produces a private answer key with a small required
finding set and known negative controls. These are frozen before either arm
runs. If the retained corpus lacks an eligible fixture, report that concrete
gap. New paid fixture generation requires a separately counted preparation
proposal; it is not hidden inside the six diagnosis runs.

The new fixture installer must support the root/child/decoy set explicitly.
The existing discovery installer assumes exactly three histories and cannot be
reused unchanged. Seed histories through supported harness locations and
configuration, and snapshot them before the live diagnosis starts. Keep the
answer key and assessment artifacts outside all Coding-Agent and Gauntlet-Agent
mounts.

## Public request and conversation

Explicitly invoke `diagnosing-superpowers`. Give a remembered task and time
window sufficient to distinguish the target, the expected behavior, the observed
symptom, and the requested scope. Do not supply the session id, storage path,
schema interpretation, or private expected findings.

The request asks for an evidence-backed local report through the skill's report
step. It explicitly says to stop there: no issue search or filing, bundle,
fixes, or follow-on search for similar incidents. This allows an involvement
finding without triggering the optional GitHub branch.

The Gauntlet-Agent supplies only this request and frozen neutral answers to
genuine intake questions. An already-scoped request can satisfy intake; a
redundant clarification is not required for a pass. No identifying rescue hint,
parser suggestion, analyst reminder, or request to improve a bad report is
allowed. Stop at the delivered report, an explicit inability to continue, or
the time limit. Retain the first delivered result, including failures.

Use the existing Quorum/Gauntlet drive with independent offline assessment for
all three harnesses. The proposed conversation/assessment split is not presumed
implemented or available for Pi. A Gauntlet-Agent self-grade alone does not
establish report correctness.

## Evidence flow and ATIF boundary

There are three distinct populations: the historical root and child being
diagnosed; the new Coding-Agent controller and its seven analyst children; and
the Gauntlet-Agent driving the test. Keep their identities and costs separate.
The report must describe the historical population, never mistake a new analyst
session for part of the incident.

The Coding-Agent reads native history because native discovery is the behavior
under test. **Quorum normalizes those sources to ATIF at its existing boundary;
assessment logic and token/time calculations consume ATIF.** No new per-harness
raw-log behavior, token, or timestamp parsers belong in the assessment layer.

Retain per-source ATIF trajectories and a source-location map connecting native
file/line locators to normalized steps and tool-call ids. This preserves session
identity when the normal capture path merges trajectories and renumbers steps.
The private key associates literal, independently reviewed expected facts with
those locators. A generic line reader can verify native quotations; it does not
interpret harness-specific usage or event semantics. Human versus injected or
parent-dispatched provenance must remain available in normalized metadata or
the mapping produced at the normalization boundary. `source: user` alone does
not establish human authorship.

Qualify the actual normalizer → capture → check/price path against the selected
root and child traces before live execution. Verify timestamp units and bounds,
call/result associations, usage semantics, duplicate handling, and child
inclusion against independently inspected values. Optional fields passing ATIF
schema validation is insufficient. If normalization drops evidence that exists
in the source, fix and test that normalizer/capture boundary; do not bypass ATIF
or grade the Coding-Agent against missing evaluator data.

Capture all new analyst sessions. In particular, qualify the native session
locations and cwd filtering rather than assuming the merged root includes the
children. Preserve per-session attribution while pricing the combined new
Coding-Agent work exactly once. Seeded historical usage is evidence for the
report, not a cost incurred by this diagnosis run.

After execution stops, collect the case, report, analyst outputs, and relevant
generated evidence files from the workdir and isolated diagnosis directory.
Accept a report in the workspace or the skill's diagnosis directory, since the
workflow and template name different locations; require the shown absolute path
to resolve to the actual file. Preserve original bytes and path mappings in the
run artifacts, including partial files on failure. Collect only the scoped
artifacts through verified paths, not the whole throwaway home or auth files.

## Acceptance and assessment

Assess every run on the same contract. Required report sections are problem,
verdict, environment, sessions, human-prompt timeline, findings, involvement,
and coverage. Findings include the seven dimensions and the template's separate
other-plugins/skills subsection; that subsection is supplied by the skill-timeline
analyst, not an eighth analyst.

| Dimension | Required evidence or justified absence |
|---|---|
| Skill timeline | Actual skill reads/invocations and their turns; any claimed missed trigger supported by the relevant installed description and checked range; other plugins/skills accounted for. |
| Plan adherence | Actual agreement and approval, observed execution, and any supported deviation; no invented plan or consent. |
| Repeated work | Correct counts and locations under the prompt's rules; legitimate rereads after edits and test/status checks are not automatically waste. |
| Stumbles | Actual failures, retries, corrections, and observed recovery; distinguish an error from its later resolution. |
| Quality evidence | Tests/actions actually performed, their results, and whether completion claims had the required supporting evidence; no fresh code-quality review. |
| Request conflicts | Real human constraints, actual conflicts and their resolution; injected instructions and child dispatches are not human requests. |
| Cost and time | Supported per-turn and per-session totals, rankings, timing boundaries, tool-result sizes, compactions, and associated sessions; unavailable values explicitly marked. |

For cost/time, check incremental versus cumulative counters before totals,
missing observations versus zero, supported turn boundaries, and attribution
of historical child work. Check top-five turns and top-ten tool results, or all
if fewer exist, with ties accepted. Tool-result sizes state whether they measure
decoded result content or serialized native records. A gap is not proof of its cause;
compaction counts and before/after values require source evidence. Historical
dollar prices are required only if the report claims them and can evidence them.

The control prompt explicitly permits prompt-to-next-human/end timing and
serialized native log-line sizes. These are distinct from active-response
duration and decoded tool-output size. Accept a coherent, clearly labelled,
evidenced convention; freeze its values and ranking before seeing results.

Freeze measurement scope along with each expected quantity. Direct root usage
and usage including a linked child are different supported measurements; the
report must state which it uses. Likewise, a final assistant message and a native
task-complete event can be different evidenced timing endpoints. The private key
may list independently established alternatives with their own scope and source
locators before launch. Accept ordinary display rounding at the precision the
report actually shows, after converting units; this is not an arbitrary numeric
tolerance. Preserve every extra numerical claim for independent support review.

A complete pass also requires:

1. Correct target and historical-child identities, full absolute source paths,
   first-prompt/time confirmation, rejected alternatives, and a usable case file.
   Include measured line/byte counts and the case template's skill-file SHA-1
   table. Environment claims distinguish currently observed installation
   metadata from what is known about the historical installation.
2. Seven distinct analyst executions, one per named dimension, receiving the
   absolute case path, common instructions, and correct dimension instructions.
   Observe dispatches and completed outputs, not just seven report headings.
   Analysts follow the arm's common instructions; the after arm consumes the
   recorded meanings. Missing or failed analysts cannot be hidden by controller
   prose. Use native parallel dispatch with available slots, allowing bounded
   waves when seven simultaneous workers are unsupported.
   A native batch call can contain multiple distinct executions. Bind each to
   its batch position and separate child source; do not require seven different
   native tool-call ids when the harness represents a parallel batch as one call.
   If native logging encrypts the initial child prompt, verify input consumption
   through that linked child's actual reads of the exact case, common, and
   dimension files. Retain the read results and state that the initial prompt
   text is unavailable. Controller assertions alone do not establish consumption.
3. Every required fixture finding recovered with supporting evidence, all real
   human prompts in the scoped timeline, and no unsupported substantive finding.
   Each empty dimension names what was checked. A fabricated problem in a
   negative control is a failure, even if all required positive facts appear.
4. Every finding has an existing absolute `path:line`, a supporting quote of at
   most 200 characters, turns, and appropriate confidence. Audit the verdict and
   involvement claims too. Involvement states evidence and uncertainty without
   proposing skill or product fixes. Unsupported historical metadata is reported
   unavailable.
5. Honest coverage notes, including unread ranges/files and unavailable fields.
   Evidence that the fixture actually contains cannot be dismissed as an
   unavailable harness feature.
6. Unchanged seeded histories and bounded transcript reads by controller and
   analysts: measurement before content, selected records/fields, and no output
   over the skill's 500-character per-record bound. Native appends to the new
   diagnosis logs are expected. Small-fixture compliance does not establish
   safety for megabyte records.
7. Verified exposure to the intended installed skill, no use of removed-reference
   copies in the after arm, and a retained report at the delivered path.

Millisecond key measurements explicitly distinguish elapsed timestamp spans
from native reported duration counters. Their evidence is not interchangeable:
a counter needs its recorded value; an elapsed span needs both endpoints. Retain
native failure and duration facts as typed ATIF result metadata. A failed read
cannot establish that an analyst consumed its inputs. Prelaunch schema refinements
may derive metadata-only key copies while preserving original freezes and all
expected values, scopes, and locators.

Keep deterministic checks and independent semantic review distinct. Deterministic
checks cover artifact presence, identity/hash preservation, structural evidence,
dispatch coverage, locators, and specified numeric facts. Independent review
checks claim support, attribution, uncertainty, meaningful coverage, and actual
read behavior against retained sources. Record the evidence and rationale for
each judgment, including disagreements with Quorum or Gauntlet results.

Do not reuse the discovery pilot's narrow citation allowlist. It rejected valid
metadata, assistant-confirmation, and decoy citations. A citation must exist
and support its claim; it need not equal a preselected answer-key line. Require
the known incident facts while accepting additional independently supported
findings. Retain every submitted citation and assess it; never discard one to
turn a report into a pass. Leave the old pilot keys and published results intact.

Use neutral arm labels during report review where feasible, and record any
unblinding; case layouts may reveal the arm. The reviewer must not rely on the
Gauntlet-Agent's self-grade or either report to construct expected truth.

## Offline qualification and implementation boundary

Implement this as a focused Quorum scenario, native fixtures, private assessment,
and finite campaign declarations. Reuse provisioning, normalizers, ATIF checks,
pricing, and appliance control. Necessary capture/artifact retention changes
serve this scenario; a new scheduler, general assessment service, or broad
normalization redesign is not a prerequisite.

Before live execution, demonstrate that the assessment accepts a reviewed
correct report and rejects mutations that select a decoy, omit a historical
child, count a parent dispatch as human speech, double-count cumulative usage,
invent test success, mislabel a justified reread, or cite a real but irrelevant
line. Accept equivalent supporting citations outside the key's preferred lines.
Check that headings without executions and an omitted analyst fail, while
evidenced `none found` findings pass. Changed historical files and a delivered
report path that does not resolve must fail. An evaluator's missing child trace
or lost timestamp must produce incomplete assessment, not a behavioral failure
or pass.

Qualify native analyst dispatch and capture using retained traces and offline
configuration/fake-provider checks on the selected Linux image. This establishes
the plumbing available for the pilot; the six live attempts establish actual
analyst behavior. No extra paid smoke run is implicit. Run focused regression
tests for code changes, `bun run check`, and `bun run quorum check` after the
scenario and declarations are implemented.

## Execution limits, accounting, and readout

Propose `n: 1`, `reserve: 0`, `max_attempts: 1`, global cap two, a fifteen-minute
scenario limit, and a twenty-minute outer attempt limit. Account for the native
analyst concurrency limit separately: two top-level attempts can each launch
several children. Freeze that limit and the effective model policy before
launch. A timeout or setup failure consumes the attempt; no automatic rerun,
rescue, or extra analyst retry is scheduled by the test driver.

The launch packet must contain the qualified fixture/key digests, public
scripts, exact source/runtime identities, six eligible slots, exposure limit,
top-level and child concurrency settings, and a cost estimate covering
controllers, all analysts, and Gauntlet-Agents. Present a separate spending
allowance for this pilot with that concrete packet. The earlier discovery
allowance does not carry forward automatically. Time/count limits are not a
hard dollar ceiling.

Use the installed appliance helper for registration, one launch, monitoring,
termination, and immutable evidence publication. Retain every attempt's costs,
including failures and unexpected children. Price Coding-Agent ATIF through
the existing obol path and keep Gauntlet usage separate. Missing or unpriced
child usage is not zero. Qualify pricing coverage before launch; if live evidence
still lacks prices, report known subtotals and coverage without claiming a
complete total or a cost win. Never repair historical campaign artifacts in place.

Publish one row per harness and arm containing workflow completion, seven-analyst
coverage, required findings recovered, unsupported findings, citation support,
numeric accuracy, source preservation, context safety, report path, diagnosis
latency, total attempt time, and token/cost coverage. Preserve per-dimension
judgments and analyst identities as drill-down evidence. Diagnosis latency runs
from the submitted request to the delivered report; attempt time also includes
setup and grading. Historical incident timing is a separate report measurement.

Distinguish a report failure from an assessment blocked by missing evaluator
evidence, and retain the formal campaign validity/completion status separately.
Do not turn an incomplete campaign into a passing comparison using manual
judgments. A shared failure in both arms is still an unfulfilled diagnosis
requirement, even when removal caused no observed regression.

The after arm must meet the complete acceptance contract independently on all
three harnesses. A successful result supports a working full-diagnosis example
for these incidents and identifies any observed before/after differences. One
pair cannot establish equivalence, reliability, or a cost improvement. Any
failed or incomplete cell remains visible and determines a targeted follow-up
proposal rather than silently expanding this pilot.

Record the preregistration and final readout in a new dated experiment entry,
with negative results given the same treatment as successes. Keep native
evidence and private keys outside public source control. This spec is complete
when its scope is reviewed; the subsequent implementation plan prepares the
scenario, qualification evidence, and concrete launch packet.

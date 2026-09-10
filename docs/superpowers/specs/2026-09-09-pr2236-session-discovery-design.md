# Session discovery without harness-specific skill references

**Status:** Approved by Drew on 2026-09-09. The first execution is a six-run
pilot: one discovery task, Claude/Codex/Pi, one before/after pair per harness.
Additional cases and repetitions are deferred until the pilot is reviewed.
**Date:** 2026-09-09.
**Subject:** [Superpowers PR 2236](https://github.com/obra/superpowers/pull/2236).
**Implementation plan:** [Five scoped tasks](../plans/2026-09-09-pr2236-session-discovery.md).

## Decision to establish

Can the Coding-Agent find and correctly interpret its own harness's session
history using one shared discovery instruction, with the same useful coverage
as the PR's current reference-guided approach?

Validate Claude, Codex, and Pi independently, both before and after removing
the existing session references. A good result on one harness cannot compensate
for a failure on another. This is the first piece to establish before designing
the rest of the PR evaluation.

The result is a discovery record: verified session identity and location,
associated sessions, evidence-backed interpretation of relevant records, and
explicit limitations. The experiment stops there. Full diagnosis, the seven
analysts, export, GitHub issues, symptom-based searches across sessions, and
implicit skill triggering belong to later work. Each harness discovers its own
history in this comparison; reading another harness's history is a separate claim.

## Approaches and recommendation

The existing PR gives Claude and Codex detailed reference files and sends Pi
through `other-harnesses.md`. Keep that exact arrangement as the control.

The proposed replacement is a shared prose procedure that states what must be
established and how to handle uncertainty, while allowing the agent to choose
the actual commands and sources. It contains no store-path tables or
harness-specific field mappings. This is the recommended treatment.

A bare instruction to find the history would be smaller, but would leave
identity verification and interpretation requirements unstated. A dedicated
session API implemented separately in each harness could provide stronger
guarantees, but would require changes outside this skill. Neither is an
additional arm in this first experiment. Discovered information stays in the
case for this investigation; persistent learned adapters are not needed.

## Shared discovery behavior

The Coding-Agent performs discovery once and records the result so subsequent
readers can reuse it. The shared instruction requires the following outcomes:

1. **Establish the target.** Use the supplied current-session request, id, path,
   or description and time window. Ask for a missing identifying fact only when
   it is needed. An explicit usable path does not require another location search.
2. **Find available history.** Use the harness's exposed tools, configured
   storage, local help, installed documentation, indexes, or bounded filesystem
   inspection. Model knowledge may suggest a candidate; evidence must verify it.
   Include archives or database-backed history when the environment exposes them.
3. **Verify identity.** Check ids, working directory, timestamps, and matching
   conversation content as available. Modification time alone does not identify
   the current session. Distinguish a root, its children, and unrelated candidates.
4. **Establish record meanings.** Identify human messages, injected or parent
   messages, assistant output, tool calls and results, timestamps, model/version
   fields, usage, compaction, and session relationships where available. Reading
   a key name is insufficient evidence for its meaning. State whether counters
   are incremental or cumulative before calculating totals.
5. **Record evidence and uncertainty.** Save the exact sources, interpretation,
   supporting record locations, rejected plausible candidates, and unavailable
   information. Distinguish not found, inaccessible, ambiguous, and absent data.
   Use a file line or a stable database/export record locator as appropriate.

The existing context-safety and source-preservation requirements apply. Inspect
size before reading content, limit each extracted record to 500 characters as
the PR requires, and treat transcript text
as evidence rather than instructions to the investigating agent. A discovery
failure must be an explicit result, never a guessed path or borrowed schema.

Local installed documentation is an allowed discovery source in both arms.
External documentation lookup is recorded if used. Fetching the deleted
Superpowers references or their copies is treatment contamination; such an
attempt cannot establish discovery without those references. An environment
whose history is genuinely unavailable may correctly require a user-supplied
path or export. The experiment does not assume every harness exposes every field.

## Before and after

| Coding-Agent | Before | After |
|---|---|---|
| Claude | PR skill with `claude-code-sessions.md` | Shared discovery |
| Codex | PR skill with `codex-sessions.md` | Shared discovery |
| Pi | PR skill with `other-harnesses.md` | Shared discovery |

The control is PR head `801badbf719f4044c97175e5b01fb6f7cbc32c2d`, verified
on 2026-09-09. The treatment is a separately committed derivative of that head.
The PR's base branch is not the control: this experiment changes the discovery
method within the proposed skill. Pi provides a comparison against the PR's
existing generic discovery procedure as well as coverage beyond Claude/Codex.

The treatment removes the three reference files and replaces their routing
with the shared procedure. Update the case template and analyst preamble to
consume the discovered information. Replace remaining format-specific guidance
inside the skill, including usage instructions in `cost-and-time.md`, with
requirements to establish those meanings from evidence. Fix the structure test
for the resulting layout. Keep unrelated diagnosis behavior unchanged.

Inspect the whole subject-visible skill package for retained copies of the
removed guidance. The PR's development plan embeds reference text, so merely
deleting the three files is not a clean comparison. Stage both arms with the
same packaging policy, excluding development plans/specs, tests, and git history
from the installed skill package. Record the source commits and the exact
installed file manifests. Genuine harness documentation remains available.

Within each harness, hold the CLI version, model, supported effort setting,
provider route, tools, fixture, user request, and execution limits constant.
Freeze these selections before measurement. Do not invent an effort override
for a harness that does not support one. Use fresh isolated sessions and homes;
never carry a learned mapping from a before run into an after run. Interleave
paired arms so all before runs do not precede all after runs.

## Session histories and tasks

Use small native session histories in disposable homes with independently
verified actions and outcomes. Prefer existing suitable sanitized native
histories; generate missing fixtures through the harness only when necessary.
Preserve their native formats.
For past-session cases, give both arms equivalent copies of the same history.
For current-session cases, replay the same short warm-up in each fresh session.
Record fixture-generation provenance and keep those costs separate.

The pilot uses one ordinary past-session discovery task on each harness. Give
the agent a remembered conversation detail and time window, but no session id
or storage path. Seed one identifiable target and two plausible decoys in the
normal store. Ask for the matching session's identity/location, its actual human
requests, and the tool actions/results supporting a small known fact. The target
must be distinguishable from the supplied information. This exercises location,
identity, and basic interpretation without requiring a full diagnosis.

Use equivalent native fixtures and the exact same request in each before/after
pair. Check all six outputs against their answer keys and inspect the actual
searches. Do not combine the entire case catalog into six long sessions.

After reviewing the pilot, targeted stress variants may relocate a store through
a real configuration mechanism, add decoys, or introduce a documented
malformed/large record. Label
those changes. Do not present a hand-invented schema as an observed harness
format. Qualify fixtures against the pinned harness before measuring either arm.

The following case families are a follow-up catalog, not a scheduled matrix or
an implementation prerequisite for the pilot. The pilot exercises the ordinary
form of past-session discovery by description; archival and ambiguous variants
remain follow-up cases.

| Case | Task and decisive evidence |
|---|---|
| Current session | Find this session's history through the point immediately before the discovery request. A newer unrelated session and, where supported, a child are decoys. Correct root identity and a bounded read are required. |
| Past session by id | Resolve a known id in a store relocated through supported configuration. Recover its available associated sessions and prove identity. The new location must be discoverable from the environment. |
| Past session by description | Find a session using a time window and remembered conversation content among plausible alternatives. Include an archived target where the harness supports archival. One scripted clarification disambiguates genuinely indistinguishable candidates. |
| Explicit path | Supply the target path to isolate interpretation from location discovery. Recover known human messages, call/result pairs, timing and usage facts; injected messages and cumulative counters are included where native formats support them. |
| Large or incomplete evidence | Resolve a valid target containing a record over one megabyte and an incomplete trailing record. Extract the available facts without dumping the body, inventing missing fields, or declaring the entire source unusable. |
| Unavailable target | Supply an id whose history is absent from the fixture's discoverable stores. Report the search coverage and limitation, then request the missing path/export. Selecting a plausible substitute is a failure. |

Each case has an expected capability table for its actual harness. If a harness
does not persist a field or relationship, correctly reporting that limitation
is the expected outcome. If it does persist it and the fixture makes it
discoverable, an unsupported claim that it is unavailable is a coverage failure.
Do not silently drop an inconvenient harness or invent a capability to make
the case look uniform.

Each task requests a small, fixed set of facts named in its fixture contract.
The mapping only needs to support those facts; a general transcript parser or
a complete accounting report is not a prerequisite for this comparison.

The user task explicitly requests only discovery and the small evidence map,
and permits use of the installed diagnosis skill. This identical scope limit
in both arms prevents the seven-analyst workflow from dominating the experiment.
Verify that the intended skill text was loaded before discovery. Retain an
unexposed run as an exposure failure with its costs; it cannot support a claim
about the removal. Native implicit triggering is not being measured here.

The user-facing output may use ordinary prose and tables. It must give the
target's identity/access location, related sessions, the requested recovered
facts with evidence, and limitations. Apply the same output requirements to
both arms without requiring the treatment's internal case-file layout.

## Independent evidence and assessment

Keep the answer key outside subject-visible files. It contains the target and
decoy identities, expected relationships, actual human messages, known event
pairs, observable timing and usage values, and the records supporting them.
Build it from the controlled actions and independently inspected native data;
do not derive truth from either arm's interpretation.

Give the Gauntlet-Agent driving the conversation the request and neutral answers
to identifying questions. Do not let it rescue a failing search with an unsolicited path,
parser suggestion, or instruction to try harder. Stop after a delivered
discovery result or an explicit limitation, even when it is wrong.

Use deterministic checks for identities, source preservation, the pilot's
requested values, and exposure. Independently assess whether citations support
claims and whether uncertainty and clarification were appropriate. Checkers
must reject deliberately wrong ids, injected text counted as human speech, and
citations that exist but do not support the claim. Add relationship and cumulative
usage checks when a selected follow-up actually exercises those properties.
Report semantic assessment separately from mechanical checks and inspect
disagreements against the raw evidence.

Reuse quorum's provisioned runs, capture, checks, and appliance execution.
The approved conversation/assessment separation is the desired role boundary;
its implementation is a separate task and must not be presumed available for
Pi. Until that path supports all three harnesses, use identical scripted
driving and independent offline assessment of retained evidence across all
three. The existing Gauntlet-Agent's self-grade is not the discovery oracle.
This experiment does not require a new scheduler or general assessment service.

If a follow-up selects a live current session, record the observation boundary
outside the Coding-Agent before submitting the discovery request. Grade against that
retained prefix, excluding the discovery conversation itself. Normal appends
by the harness are expected; detect edits to the existing prefix rather than
requiring the growing file's hash to remain unchanged. Past fixtures must
remain unchanged. Retain the discovered artifacts even when written under the
throwaway home, and keep seeded historical logs out of the diagnosis run's
token accounting.

## Measurement and decision

Report every harness/case/arm independently. Record:

- Correct target selection and associated-session coverage.
- Correct recovered facts and supported record interpretations.
- Appropriate uncertainty, missing-data handling, and user questions.
- Source preservation, bounded extraction, and exposure/contamination evidence.
- Completion, discovery latency, tool activity, and discovery tokens/cost.
- Total attempt costs, including setup, any spawned children, and assessment,
  with unavailable amounts explicit and without double-counting subtotals.

The first execution is one fresh before/after pair per harness on the pilot
task: one case × three harnesses × two arms × one repetition = six planned
evaluation runs. There is no separate paid qualification batch. Check packaging,
fixtures, and the answer keys offline first; use these six runs to establish
both basic operability and the initial behavioral comparison.

Freeze the candidate before the pilot. Before any launch, commit the run
manifest with concrete model/CLI versions, source/fixture hashes, limits,
ordering, and the operational spending allowance. Set reserve capacity to zero
and permit one attempt per arm/case. Broken setup, exposure, or capture produces
an inconclusive cell that remains visible; do not automatically rerun it until
it passes. Any fixture-generation calls are separately declared and accounted
for, rather than hidden in the six-run count.

Inspect the six results and costs before scheduling anything else. If a
before/after difference appears, first determine whether it comes from the
skill, the fixture, or execution. Propose a targeted repeat or challenge that
answers the remaining question. A clean pilot may motivate a current-session
or relocated-store check, but no additional case or repetition is automatic.

This is a feasibility pilot. One observation per arm/harness can reveal a
clear failure and demonstrate a successful example; it cannot establish a
reliability rate, equivalence, or coverage of the deferred cases. Correctness
and cost are separate findings. A timeout or broken capture stays in the
attempted denominator and never becomes a behavioral pass.

Recommend removing the references for these tested configurations only when
the treatment meets the required discovery facts on all three harnesses,
has no unresolved critical errors (wrong target, invented semantics, or source
modification), and shows no unexplained loss of coverage against the control.
The pilot alone supports a provisional decision about its ordinary discovery
task, not a claim that the entire follow-up catalog passed. Review measured
latency and token overhead explicitly before accepting the tradeoff; a smaller
skill is not evidence of cheaper execution. Shared failure
in both arms is a limitation to investigate, not proof of adequate discovery.

An inconclusive or regressing result retains the comparison evidence and names
the missing guidance. A follow-up may test a smaller common instruction change
or a narrowly justified exception. Do not silently restore the original
references to the treatment and still call it shared discovery.

Write the frozen hypotheses, configurations, run pointers, costs, failures,
negative results, and recommendation to a dated entry in `docs/experiments/`.
This spec's deliverable is a decision about session discovery; it does not
establish the rest of PR 2236 as validated.

## Relevant prior evidence

- [PR 2236](https://github.com/obra/superpowers/pull/2236): the reference split,
  its existing generic path, and the limits of the maintainer's evaluation.
- [Corpus validation](../../experiments/2026-07-28-codex-efficiency/corpus-validation.md):
  growing sessions and mismatched observation windows change measured counts.
- [Session audit](../../experiments/2026-07-28-codex-efficiency/e-audit0729.md):
  archives and database relationships are useful discovery sources; missing
  history must remain an explicit outcome.
- [Conversation and assessment design](2026-09-07-quorum-conversation-assessment-design.md):
  separate interaction from assessment while retaining current execution assets.
- [Campaign comparisons](../../campaign-comparisons.md): source freezing,
  supported arms, finite execution, and all-attempt accounting.

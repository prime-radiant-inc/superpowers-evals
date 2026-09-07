# Unified eval product: working design

**Status:** Brainstorming draft; not an approved specification or implementation plan.
**Participants:** Drew and Bot.
**Started / last updated:** 2026-09-07.
**Purpose:** Preserve the discussion and its reasoning while we develop a spec.

## Resume here

Drew wants a simpler, modular eval product and has agreed to explore
consolidating Superpowers Evals and smevals. The initial architecture and
smevals investigations are complete. We are now discussing the desired
authoring and execution experience; implementation has not started.

The six requirements below come directly from Drew. The component choices
and first milestone are proposals. No existing implementation, language,
or orchestration policy is a constraint on the new design.

**Authoring clarified:** Drew wants to define basically none of the exchange.
Use the current prose scenario brief and acceptance criteria as the starting
point; the driver conducts the conversation. No authored turn sequence or
mandatory reply/persona schema. Next, discuss the complete single-scenario
execution boundary and target configuration using that authoring model.

Keep this document current after substantive discussion: promote an agreed
proposal into a decision, retain a short reason when an alternative is
rejected, and update this checkpoint. The eventual spec should grow from
this document. Research reports remain supporting evidence.

## What Drew wants

1. Describe eval scenarios in natural-ish language, using YAML or similar.
2. Run those scenarios by driving a live coding harness as an end user would.
3. Select an arbitrary group of supported model/harness combinations.
4. Support all models/harnesses supported by Superpowers.
5. Emit a standardized report instead of bespoke analysis.
6. Run with high parallelism within a harness and across multiple harnesses.

Superpowers runs in a user-driven loop. An eval must reproduce the relevant
interaction: questions, clarification, design/plan approval, follow-up,
implementation, and completion. Calling a model API directly is useful for
other smevals evals, but does not establish that experience.

Drew explicitly permits reconsidering every layer, including Quorum,
Gauntlet, drivers, and reports. Components should have useful boundaries;
no component should dictate the whole product.

## Scope and decision status

| Item | Status |
|---|---|
| The six product requirements above | Agreed requirements from Drew. |
| Real end-user interaction for Superpowers tests | Agreed requirement; exact interaction controls need design. |
| Author defines basically none of the exchange | Explicit clarification from Drew; preserve the current prose-brief authoring model. |
| Modular components and replaceable layers | Agreed direction. |
| Centralize efforts around one eval product in smevals | Working direction following the team investigation and Drew's agreement to brainstorm it. |
| Preserve smevals' current execution implementation | Not a requirement; evolve or replace internals according to the design. |
| Keep one working document through brainstorming | Requested by Drew to preserve context across compaction. |
| Specific schemas, command syntax, packaging, deployment, and migration | Open; not approved. |
| Implementation, existing-code removal, or paid runs | Not authorized by this design discussion. |

Sealing, restart recovery, deep statistics, and elaborate analysis are
deferred. They should not return as prerequisites merely because older
campaign designs required them. Their future value remains a separate
question. Automatic retries, historical sample top-up, and fleet scheduling
are also not established requirements.

Basic execution correctness still matters: independent sessions, known
effective inputs, finite time limits, cancellation/cleanup, retained
evidence, and a visible distinction between subject failure and instrument
failure. The mechanisms and first-version scope remain to be designed.

## Proposed user experience

An author writes a natural-language scenario brief and acceptance criteria,
with starting fixtures and deterministic checks supplied separately. The
driver reads the brief and conducts the live conversation. The author should
not have to enumerate questions, answers, approvals, or conversation states.
They choose target configs and repetition/concurrency settings, start a batch,
inspect progress, and receive the same report format for every target.

### Start from the existing scenario abstraction

The current format is `story.md` with YAML metadata and prose, `setup.sh`
for the fixture, and `checks.sh` for deterministic pre/post assertions.
The story briefs the Gauntlet-Agent and includes semantic acceptance
criteria; it is not a transcript or a machine-readable dialogue program.

For example, `sdd-go-fractals-opus48/story.md` gives an example initial
request, then says to let the coding agent proceed autonomously and answer
clarifications briefly. `code-review-catches-planted-bugs/story.md` gives
a review request, forbids revealing the planted defects, and says a completed
bad review is still a completed run. Gauntlet handles the actual interaction.

Some targeted tests pin particular messages or contingent replies because
those are the stimulus being tested. `brainstorming-todo-purpose-discovery`
has a detailed response policy, and the current authoring guide encourages
canned replies. That is evidence of existing experimental controls, not a
requirement that every new scenario define an exchange. Drew's desired
default is the lighter prose brief. Exact wording or constraints can remain
scenario-specific when necessary to express the test.

**Design consequence:** Preserve this level of abstraction when integrating
with smevals. A story may remain Markdown or be referenced/embedded in YAML;
file packaging is open. Do not invent a mandatory conversation DSL, persona
form, or answer-policy schema. Shared driver behavior should carry ordinary
interaction mechanics. This authoring choice does not yet settle whether
the user actor and semantic grader share an implementation or model.

The scenario should be reusable across supported targets. Harness, subject
model/provider, Superpowers version/configuration, and interaction settings
belong in explicit target configuration rather than per-scenario wrappers.
The location of those fields and the authoring vocabulary are proposals,
not a frozen schema.

There are three distinct roles:

- **Simulated user:** interprets the prose brief, supplies the request, and
  handles the conversation without an author-specified sequence of turns.
- **Coding agent:** the actual model/harness under test, running Superpowers.
- **Evaluator:** checks the resulting behavior and artifacts.

These are logical responsibilities, not a requirement for three services
or three LLMs. Their model/configuration identities must remain distinct.
A deterministic evaluator may require no LLM. Private grading criteria
should not become coaching instructions for the simulated user.

Conversational approvals, native question-tool dialogs, and harness tool
permission prompts are separate behaviors. The intended interaction mode
must be explicit; a bypass flag should not silently redefine the test.

## Candidate component boundaries

The team recommends using smevals' Runner and Checker executable boundaries
as the starting point. Files and structured input/output can connect Python
and TypeScript. There is no demonstrated need for a language rewrite or
a per-turn RPC service in the product core.

| Responsibility | Candidate implementation; not a final selection |
|---|---|
| Authoring, target selection, and batch submission | smevals CLI; Studio as an optional client of the same core. |
| Finite job dispatch, resource caps, and process supervision | One shared core within smevals; existing execution internals may change. |
| One complete live attempt | A reusable worker that provisions, drives, captures, and cleans up one session. |
| User interaction | Gauntlet's existing TUI loop initially; CSD or another driver where it preserves the required behavior. |
| Harness setup, fixtures, capture, and checks | Reuse selected Quorum code behind appropriate boundaries. |
| Evaluation and reporting | Independent checkers/graders; one selected result set and reader for CLI, UI, and static output. |

Direct model-call runners should remain useful in the same product without
requiring a simulated user. Superpowers Evals would contribute a scenario
suite and reusable workers/checkers. Gauntlet and other general-purpose
components can remain independently useful packages or repositories.

## Findings that constrain the design

- Main smevals drops nested task values and most config fields before
  execution. The reusable-runners branch improves config delivery but does
  not preserve the complete resolved config. A worker and its result need
  to agree on the actual inputs, including overrides.
- Quorum's behavioral-failure exit code means execution failure to smevals.
  A naive wrapper loses valid failing observations. Quorum's standalone
  launch lock also prevents arbitrary parallel fan-out from another runner.
- Missing or broken smevals checkers can become behavioral failures.
  Execution status and evaluation outcomes need distinct representations.
- Reports differ in result inclusion, and Studio's executive matrix keeps
  only the busiest config. A common report must retain every selected target,
  including errors, ungraded work, and partial/all-error batches.
- The concurrency PR launches parallel subprocesses, but inherits HOME and
  lacks universal deadlines/process-tree cancellation. Its generation
  barrier delays grading and completion output. Parallel interactive
  correctness remains unproved.
- Gauntlet provides a real interactive TUI driver and currently also
  self-grades. CSD supports Claude/Codex/Pi, disables Claude's question tool,
  and lacks a mid-turn question-response state. Neither is automatically
  the final interaction contract.
- Existing normalizers, executable extensibility, and adapter names do not
  prove that every required harness/model/Superpowers combination works.

The team ran a provider-free probe of pinned smevals PR #2. Eight local
0.3-second jobs completed in 2.938 seconds at concurrency 1 and 0.7615 seconds
at concurrency 4, with the corresponding peak process counts observed.
One deliberately nonzero runner left seven successful siblings and grades.
All workers inherited one HOME. This proves subprocess overlap and ordinary
nonzero-exit handling, not live-harness fidelity, cancellation, or throughput.

The earlier rejection of smevals emphasized serial dispatch and campaign
statistics. Those observations do not make its authoring/extension model
unsuitable for the smaller requirements now under discussion.

## Proposed first proof

One YAML scenario requires clarification and approval before implementation.
Run it through two genuinely different supported harnesses, with repeated
sessions overlapping within and across them. Use multiple supported model
selections where available. Produce one report that correctly distinguishes
behavioral failure, execution error/timeout, and grading error, retaining
the relevant evidence.

Use offline workers for bounded supervision and failure cases, then real
sessions for interaction fidelity. This is a proposed milestone, not a run
plan or spend approval. Full supported-target coverage remains part of the
goal after the initial slice.

## Discussion queue

Discuss these in the order that helps the design; they are questions, not
separate process gates or implementation tasks.

1. **Single-scenario execution:** Given a prose story, fixture, and checks,
   what does the runner own from setup through completion and evidence capture?
2. **Targets:** Which settings must be independently selectable, and what
   should unsupported combinations look like before execution?
3. **Execution experience:** Where should the first useful version run, and
   what progress, cancellation, and concurrency controls does Drew need?
4. **Evaluation/report:** What is the minimum useful result, what evidence
   supports it, and which expected outcomes require deterministic or LLM checks?
5. **Interfaces and reuse:** Derive the Runner/Checker and internal harness
   boundaries from the agreed experience; decide what existing code fits.
6. **First slice and migration:** Pick the actual scenario/targets, define
   acceptance evidence, and decide how existing users and scenarios move over.

## Evidence and history pointers

Pinned source inspected on 2026-09-07:

| Repository / development line | Revision |
|---|---|
| smevals main | `0c28dc6298eb0e6c3b47e296e82a6972a01d76d0` |
| smevals reusable-runners | `45676afdc07eb1c9ad6290a519c2c323f0861a68` |
| smevals wip/studio | `94a8c20959aa804135b5b45a357aa7f378d44e37` |
| smevals concurrency PR #2 | `a20b6771bf6bbc5f7dc3f6d24b8c972b26dc7cd4` |
| Superpowers Evals | `32b403be1018bbbf460ca30dd61f9e16eb8b9b8c` |
| Gauntlet | `588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df` |
| claude-session-driver | `e608d693247b19c4fe2c2e85abe61b29586c24cd` |

- [smevals source](https://github.com/prime-radiant-inc/smevals/tree/0c28dc6298eb0e6c3b47e296e82a6972a01d76d0)
- [Concurrency PR #2](https://github.com/prime-radiant-inc/smevals/pull/2)
- [August direction panel](../../experiments/2026-08-17-platform-direction-panel.md)
- [Current scenario authoring guide](../../scenario-authoring.md)
- [Go fractals story](../../../scenarios/sdd-go-fractals-opus48/story.md)
- [Code review story](../../../scenarios/code-review-catches-planted-bugs/story.md)
- [Purpose-discovery response controls](../../../scenarios/brainstorming-todo-purpose-discovery/story.md)
- [Local smevals investigation and five peer reports](/Users/drewritter/.codex/visualizations/2026/09/07/01a07cbc-47f5-70d0-803e-acdaff77da82/smevals-unification/READOUT.md)
- [Local Quorum architecture/history/evidence investigation](/Users/drewritter/.codex/visualizations/2026/09/07/01a07cbc-47f5-70d0-803e-acdaff77da82/evals-architecture-audit/READOUT.md)

The local investigation paths are discussion evidence on Drew's machine,
not portable repository dependencies. Older campaign specs document the
current system; their requirements do not automatically carry into this one.
Mutable source and live-environment facts need rechecking when used for
implementation or operational claims.

## Discussion record

- **2026-09-07:** Drew restated the six core requirements, emphasized the
  live user loop and modular boundaries, and made every layer replaceable.
  Sealing/recovery/deep analysis were removed as core prerequisites.
- **2026-09-07:** A five-agent smevals investigation recommended one product
  in smevals with reusable harness workers and replaceable execution internals.
  Drew agreed to brainstorm that direction toward a spec.
- **2026-09-07:** Drew requested a persistent working design document to
  avoid losing context to compaction. This draft records the starting point;
  detailed interfaces and implementation remain open.
- **2026-09-07:** Drew clarified that he wants to define basically none of
  the exchange and directed us to the existing scenario format. Reviewed the
  authoring guide, scaffold, setup/checks, and ordinary and targeted stories.
  Established prose brief plus acceptance criteria as the authoring baseline;
  removed authored dialogue mechanics as the default design question.

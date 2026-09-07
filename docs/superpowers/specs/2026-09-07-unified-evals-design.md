# Unified eval product: working design

**Status:** Brainstorming draft; not an approved specification or implementation plan.
**Participants:** Drew and Bot.
**Started / last updated:** 2026-09-07.
**Purpose:** Preserve the discussion and its reasoning while we develop a spec.

## Resume here

Drew wants a simpler, modular eval product and has agreed to consolidate
around smevals with a replaceable runner owning each complete live harness
interaction. The initial architecture and smevals investigations are complete.
We are now refining the execution experience; implementation has not started.

The six requirements and product/runner boundary below are agreed with Drew.
Specific component implementations and the first milestone remain proposals.
No existing implementation, language, or orchestration policy is a constraint
on the new design.

**Authoring clarified:** Drew wants to define basically none of the exchange.
Use the current prose scenario brief and acceptance criteria as the starting
point; the driver conducts the conversation. No authored turn sequence or
mandatory reply/persona schema. The complete interaction is one smevals run;
the core does not manage individual exchanges. Most live execution will use
the existing appliance for its shared credentials and Mantle/Bedrock access.
Drew confirms there are no old Quorum workloads to support. The new product
has no Quorum coexistence or backward-compatibility requirement. Drew agrees
to reuse existing auth sources and useful harness delivery code, with separate
responsibilities for targets, connections, and shared resource limits. Exact
schemas and target-selection UX remain open. Drew agrees that a completed
bad implementation or review is a valid run and important signal. Evaluate
the transcript and any scenario outputs after the interaction. Worker
implementation, grading/report shape, and execution controls remain open.

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
| Centralize efforts around one eval product in smevals | Agreed direction. |
| One complete interaction per Runner invocation | Agreed boundary: smevals schedules runs and owns common results/reporting; the replaceable runner owns the live interaction. |
| Completion is distinct from behavioral success | Agreed: completed bad implementations and reviews remain runs and important signal. Do not coach toward a passing grade. |
| Grade the transcript and scenario outputs | Explicit requirement from Drew. Evaluate outputs when the scenario produces them; transcript evaluation remains required. |
| Most live execution on the existing quorum appliance | Agreed direction; deployment details remain open. |
| Support old Quorum workloads or compatibility | Explicitly out of scope. Drew confirms there are no workloads to preserve. |
| Reuse auth delivery; separate targets, connections, and resource limits | Agreed direction. Exact schemas, target selection, and extraction details remain open. |
| Preserve smevals' current execution implementation | Not a requirement; evolve or replace internals according to the design. |
| Keep one working document through brainstorming | Requested by Drew to preserve context across compaction. |
| Specific schemas, command syntax, packaging, deployment, and scenario reuse | Open; not approved. |
| Implementation, existing-code removal, or paid runs | Not authorized by this design discussion. |

Sealing, restart recovery, deep statistics, and elaborate analysis are
deferred. They should not return as prerequisites merely because older
campaign designs required them. Their future value remains a separate
question. Automatic retries, historical sample top-up, and fleet scheduling
are also not established requirements.

Quorum is being replaced as an eval product. There is no requirement for
parallel operation of old and new engines, legacy CLI/result compatibility,
campaign continuation, or a compatibility bridge. Reuse existing scenarios,
infrastructure, and code where they serve the new requirements; preserving
the old product's behavior is not an acceptance criterion.

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

## Agreed product boundary and candidate implementations

smevals owns scenario/config selection, scheduling, result collection,
grader invocation, and standard reporting. A replaceable interactive Runner
reads the prose brief, prepares the workspace, drives the real coding harness,
handles the whole conversation, and returns execution evidence. Superpowers
scenarios and checkers describe and evaluate the behavior under test.

Harness-specific dialog handling and Superpowers workflow knowledge belong
inside workers/checkers rather than the smevals scheduler or core authoring
schema. smevals can remain a general-purpose eval product: direct model-call
evals use simpler runners through the same whole-run boundary. Improvements
to configuration delivery, target selection, supervision, and error/report
semantics are shared execution capabilities.

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

### Proposed live worker implementation

Start with one isolated worker process per attempt. It receives resolved
inputs, prepares the workspace and selected harness/auth/Superpowers setup,
uses Gauntlet to conduct the conversation, and returns the transcript,
workspace artifacts, and execution status. Reuse useful Quorum provisioning
and capture code at these steps. The driver implementation remains replaceable.
The supervisor provides a deadline and cancellation that stops the worker's
process tree; preserve available evidence when a run stops early.

### Agreed completion and grading evidence

Finish the interaction when the requested task has concluded, even when the
coding agent did it badly. A completed bad implementation or review is a run
and provides important signal; retain it in the results. Normal questions,
approvals, and feedback remain part of the simulated user's role. Private
grading criteria must not drive repeated coaching until the subject passes.
A scenario can explicitly exercise correction or persistence when that is
the behavior under test, without requiring ordinary authors to script turns.

Run final evaluation after the interaction, covering the transcript and any
outputs the scenario produces. The transcript establishes behavior such as
clarification, approval, skill use, and review reasoning. Outputs establish
the quality of produced code, reviews, plans, or other deliverables. A review
or plan may itself appear in the transcript; these are evidence sources, not
a requirement for two files, two graders, or separate aggregate scores. Correct
code does not establish that the required workflow was followed, and a good
conversation does not establish that the resulting implementation works.

**Proposed grading contract:** Use acceptance criteria to select relevant
transcript and output evidence, with findings tied to that evidence. Some
criteria need both. Do not require a file artifact for a conversation-only
scenario. When output capture succeeds but an expected deliverable was never
created, that absence is behavioral evidence. Failed capture or a broken
checker is an evaluation/instrument problem, not proof of bad subject behavior.

Gauntlet's own assessment may be retained as evidence, but does not decide
whether a behavioral failure counts as a completed execution. Deterministic
checks may suffice, with a model-based checker selected where semantic
evaluation needs one. The exact grading contract, report representation, and
adaptation of Gauntlet's current self-grading loop remain open.

## First execution environment and proposed deployment

Use the existing quorum appliance for most real eval execution. Drew points
to the shared credentials and Mantle/Bedrock access already available there.
Keep scenario authoring, static validation, and provider-free development
checks convenient locally. Local live execution need not reach full parity
before the first useful appliance-backed version.

The proposed initial deployment is the smevals batch engine on one appliance,
launching independent live-session workers there. CLI/UI submission and
report retrieval should use the same run/config/result contracts. The exact
submission transport remains open; a fleet scheduler or new always-on remote
service is not a prerequisite for this first host.

Reuse the host, provider access, and useful runtime/provisioning pieces while
implementing the agreed whole-run boundary. The new engine owns execution on
the appliance. Quorum's campaign controller, registration, seals, CLI entry
points, and report policy impose no compatibility requirement on that design.

Credentials remain managed in the execution environment and are supplied to
workers as needed. Scenario authors should not have to copy the shared bundle
to their machines or reimplement provider authentication. Verify the actual
selected auth path when integrating, rather than assuming every provider
requires a new bearer token or credential arrangement.

Shared access does not establish unlimited parallel capacity. Bound active
sessions and shared provider/resource use within the new engine. There is no
old Quorum scheduler or workload to coordinate with. Large artifact handling
and reporting must not block dispatch or stopping active workers. Exact limits
require a real workload check and are not set by this discussion.

The appliance is a Linux execution environment. Targets requiring another
OS or runtime need a separate compatible executor later; the appliance must
not redefine the full supported-harness requirement. Keep the core host-neutral
without building multi-host orchestration before it is needed.

The execution location is agreed; deployment details remain proposals based
on the user's context, the runbook, and the earlier investigation. No new
live health, credential, quota, or capacity check was performed for this
discussion.

## Target and credential model

**Agreed direction:** Reuse the appliance's existing credential sources and
the useful harness-specific delivery code. Separate the target being tested,
its connection/auth configuration, and shared resource limits. No new secret
manager or provider-authentication service is proposed. The implementation
details below remain recommendations, not an approved schema or extraction
plan.

### What the current system combines

`credentials.yaml` is a committable registry of references and metadata, not
the secret bundle. Its `Credential` record combines model, API/endpoint,
auth method and source, harness eligibility, region/provider quirks, and
capacity settings. The file's opening comment and the August platform design
explicitly identify model-to-credential coupling as a deliberate compromise.

That compromise helped keep the requested model consistent across launch
and reporting. The new model must preserve that consistency without forcing
one named credential record per model. Resolve one complete run configuration,
apply precedence once, and give the worker and report the same non-secret
effective settings. Keep exact provider request identifiers and observed
model identities distinct; do not rewrite request IDs using display-name rules.

### Agreed configuration responsibilities

| Concept | Responsibility |
|---|---|
| Target | What is tested: harness, exact model, connection reference, effort/settings, and Superpowers selection. |
| Connection | How the selected model is reached: API/protocol, endpoint or region, provider settings, and reference to appliance-managed authentication. |
| Resource limits | Named shared capacity and optional launch spacing consumed by resolved work; independent of the secret's name. |

These are configuration responsibilities, not three new services. A named
target can remain convenient to select while several targets share one
connection/auth source. The author-facing choice between target presets and
ad hoc harness/model selections remains open. Ordinary scenarios do not
contain credentials or provider setup.

The coding agent, simulated user, and any model-based grader have explicit
model/access selections. Those roles may intentionally share a connection;
separate roles do not automatically require different keys or accounts.
Each process receives its selected auth/routing configuration. An API-only
grader need not have a coding harness or Superpowers settings.

### Reuse the delivery work, change its surrounding contract

Keep or extract the family/auth delivery mappings, selected environment and
OAuth-file projection, private auth-file writers, isolated HOME/XDG setup,
and harness-specific configuration generation. Codex subscription and custom
provider setup, Pi's provider-scoped native login, and Claude's API-key,
setup-token and Mantle paths contain useful implemented behavior. Replacing
these with generic API-key injection would lose supported modes.

Accept resolved target/connection information and an explicit credential
source at the extracted boundary, instead of loading Quorum's registry and
coding-agent YAML from an evals-root argument. Keep secret values in private
execution state outside task/config/report artifacts. Retain endpoint and
reference validation, and reject unsupported harness/auth/protocol combinations
before launch; a connection's existence does not imply universal compatibility.

The inspected Claude/Mantle route explicitly uses the selected bearer and
region. This source audit establishes neither live IAM/IMDS readiness nor a
need to obtain a new bearer. Preserve the available route and verify its
actual source during integration. Native OAuth also remains in scope:
`prepareAttemptStage` rejects OAuth as a V2 campaign restriction, despite
the underlying delivery map supporting it. That restriction does not carry
into the new product.

Do not import the appliance's fixed staging/active/recovery generation
lifecycle, campaign authority, route-attestation policy, or registry-wide
constraints as a credential subsystem. Reuse appropriate file/projection
primitives inside the new worker lifecycle, with private per-run destinations.

### Quota identity is not credential identity

Current direct execution groups by endpoint/name plus API; the campaign pool
derivation additionally includes model unless explicitly overridden. Neither
derivation alone expresses every provider's shared limits. Multiple models
can use one credential with different limits, and multiple credentials can
share an account-wide limit. Use explicit resource groups, allowing a run to
consume more than one where needed. Include user-actor/grader usage when they
share those resources. One authoritative definition per group avoids
reconciling repeated limits across credential aliases. Automatic key rotation
or campaign reservation algorithms are not required by this proposal.

Source inspection on 2026-09-07 covered the public registry/schema,
resolution, scope projection, Claude/Codex/Pi provisioning, and both quota
derivations. Existing contract tests were read, not rerun. No secret bundle,
native auth file, environment values, remote host, or live provider was read
or exercised. Useful source pointers:

- [Credential schema](../../../src/contracts/credential.ts)
- [Delivery selection](../../../src/credentials/scope.ts)
- [Auth resolution and direct limiter](../../../src/credentials/resolve.ts)
- [Appliance material projection](../../../src/appliance/credential-scope.ts)
- [Claude provisioning](../../../src/agents/index.ts)
- [Codex provisioning](../../../src/agents/codex.ts)
- [Pi provisioning](../../../src/agents/pi.ts)
- [Campaign pool derivation](../../../src/contracts/campaign/pool.ts)
- [Campaign-only projection restrictions](../../../src/campaign/attempt-projection.ts)

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
the relevant evidence. Evaluate both the interaction transcript and the
produced implementation; retain completed failing outcomes in the report.

Use offline workers for bounded supervision and failure cases, then real
sessions for interaction fidelity. This is a proposed milestone, not a run
plan or spend approval. Full supported-target coverage remains part of the
goal after the initial slice.

## Discussion queue

Discuss these in the order that helps the design; they are questions, not
separate process gates or implementation tasks.

1. **Evaluation/report:** Define criterion results and evidence references
   for the agreed transcript/output coverage, including deterministic and
   model-based checks and unavailable evidence.
2. **Execution experience:** What progress, cancellation, and concurrency
   controls does Drew need for appliance execution?
3. **Target selection:** Choose how users select targets and specify
   resolution/compatibility behavior within the agreed configuration separation.
4. **Live worker:** Choose the initial implementation and specify setup,
   capture, termination, and cleanup within the agreed whole-run boundary.
5. **Interfaces and reuse:** Derive the Runner/Checker and internal harness
   boundaries from the agreed experience; decide what existing code fits.
6. **First slice and scenario reuse:** Pick the actual scenario/targets,
   define acceptance evidence, and select useful scenarios/adapters to bring
   across. No old Quorum workload or compatibility migration is required.

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
- [Current appliance runbook](../../appliance-runbook.md)
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
- **2026-09-07:** Drew agreed that this remains a good fit for smevals at the
  whole-run extension boundary. smevals owns scheduling, results, grading
  invocation, and reporting; a replaceable runner owns the complete live
  harness interaction. Specific runner implementations remain open.
- **2026-09-07:** Drew suggested running mostly on the quorum appliance to
  reuse shared credentials and Mantle/Bedrock access. Bot recommended the
  appliance as the first execution environment, with local authoring and
  offline checks. Reuse of infrastructure is distinct from adoption of the
  existing campaign controller; deployment specifics remain a proposal.
- **2026-09-07:** Drew agreed with appliance execution and clarified there
  are no old Quorum workloads. Removed coexistence, backward compatibility,
  and old-workload migration requirements. The appliance and useful code can
  be reused while replacing Quorum as a product.
- **2026-09-07:** Drew asked whether to port or replace the credential system.
  Inspected its schema, history, resolution, quota semantics, and actual
  harness delivery with two focused peer audits. Bot recommends reusing auth
  sources and delivery implementations while separating targets, connections,
  and resource limits. The configuration design remains a proposal; no secret
  material or live authentication was inspected.
- **2026-09-07:** Drew agreed to the target/connection/resource-limit
  separation and reuse direction. Exact configuration syntax and extraction
  details remain open. Bot proposed the live worker lifecycle and a completion
  rule that permits completed bad outcomes, with final evaluation after the
  interaction rather than coaching toward a passing grade.
- **2026-09-07:** Drew agreed that completed bad implementations and reviews
  remain runs and provide important signal. He explicitly required grading
  both the transcript and outputs when the scenario produces them. Promoted
  completion and evidence coverage to decisions; the worker implementation
  and detailed grading/report contract remain open.

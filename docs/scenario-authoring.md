# Authoring a quorum scenario (evergreen)

Use this durable reference to write a quorum scenario: the three-file unit that
puts a Coding-Agent under test and judges its behavior. The guide covers the
five authoring jobs: anatomy, `story.md`, `setup.sh`, `checks.sh`, and
debugging. When code enumerates a fact, such as verb lists, helper names, or
error stages, this guide names the **source of truth** and shows how to
regenerate the list instead of pasting a table that will rot.

## The mental model in 60 seconds

- A scenario is a directory `scenarios/<name>/` with exactly three files:
  `story.md`, `setup.sh`, `checks.sh`.
- A run involves **two LLMs**: the **Gauntlet-Agent** (the QA tester that reads
  `story.md`, drives the agent, and self-grades against your Acceptance Criteria)
  and the **Coding-Agent** (the subject — Claude, Codex, …).
- Run flow: `setup.sh` builds a fixture → `pre()` asserts the fixture →
  the Gauntlet-Agent drives the Coding-Agent → quorum captures the session into
  `trajectory.json` → `post()` asserts the outcome → the composer writes one
  verdict.
- **`final = pass`** iff the **Gauntlet-Agent passed AND every post-check
  passed**. **`final = indeterminate`** means quorum could not grade the run: a
  crash, failed pre-check, empty transcript, or missing tool blocked evaluation.
  **`final = fail`** is the graded negative: the Gauntlet-Agent failed, or a
  post-check failed.
- The Gauntlet-Agent **never sees `checks.sh`.** It grades only the prose in
  `story.md`. `checks.sh` is quorum's independent, deterministic second opinion.

## Table of contents

1. [Anatomy & getting started](#1-anatomy--getting-started)
2. [Writing `story.md` and acceptance criteria](#2-writing-storymd-and-acceptance-criteria)
3. [Writing `setup.sh` and fixtures](#3-writing-setupsh-and-fixtures)
4. [Writing `checks.sh`](#4-writing-checkssh)
5. [Debugging a non-passing run](#5-debugging-a-non-passing-run)
6. [Worked examples](#6-worked-examples)

---

## 1. Anatomy & getting started

### The three files

| File | Purpose | Executable? |
|---|---|---|
| `story.md` | Briefs the Gauntlet-Agent: the role it plays, the exact message it sends, when it stops, and the Acceptance Criteria it grades against. | n/a |
| `setup.sh` | Builds the fixture the Coding-Agent will work in, using `$QUORUM_WORKDIR`. Run as a subprocess. | **Yes** (`src/scaffold.ts` `fixExecutableBits`) |
| `checks.sh` | Defines `pre()` and `post()` — quorum's deterministic assertions. **Sourced**, not executed. | **No** — quorum `source`s it (`src/checks/index.ts`); `chmod +x` is a hazard, not a requirement |

The exec-bit asymmetry is load-bearing and the most common authoring trap.
`setup.sh` runs directly via `spawnSync` (`src/setup-step.ts`), so it must be
executable. quorum sources `checks.sh` inside `bash -c` (`src/checks/index.ts`
`runPhase`), so it must lack the executable bit and contain **only function
definitions**. Any top-level statement fails `quorum check` (the brace-depth scan
in `src/scaffold.ts` `validateChecksSh`).

### Scaffold a new scenario

```
bun run quorum new <name>
```

`newScenario` (`src/scaffold.ts`) stamps a structurally valid skeleton: a
`story.md` with `id`/`title`/`quorum_tier` frontmatter and an `## Acceptance
Criteria` heading; a `setup.sh` (executable) that calls
`setup-helpers run create_base_repo`; and a `checks.sh` (non-executable) with a
`pre()` asserting `git-repo`/`git-branch main` and an empty `post()`.

### Validate

```
bun run quorum check                   # validate ALL scenarios
bun run quorum check <name> [<name>…]  # validate only the named scenario(s)
```

`quorum check` accepts the same scenario-name forms as `run`: a bare `foo` or a
`scenarios/foo` path both resolve (`src/cli/index.ts`). Use that to tighten the
loop to the scenario you are editing. It is a **static** validator: it never
launches an agent and needs only the scenarios root, not `SUPERPOWERS_ROOT`.

`checkScenario` (`src/scaffold.ts`) verifies these contracts for each scenario:
`story.md` has `id` and `title` frontmatter plus an `## Acceptance Criteria`
section; `quorum_tier`, when present, is one of `sentinel | full | adhoc`;
`setup.sh` is executable; every `setup-helpers run <helper>` token names a known
helper; `checks.sh` exists, parses (`bash -n`), defines only `pre()` and
`post()`, has no backgrounded (`&`) check, and **never references
`$QUORUM_WORKDIR`**. That variable is not set in `checks.sh`; see §4.

### Run one

```
bun run quorum run scenarios/<name> --coding-agent <claude|codex|…>
```

`--coding-agent` is required. Unlike `quorum check`, **running** a scenario needs
`SUPERPOWERS_ROOT`: provisioning stages the plugin from it, and every
`needsSuperpowersRoot` setup-helper resolves it. If you leave it unset,
provisioning fails fast with `SUPERPOWERS_ROOT not set; cannot install …` (per
harness in `src/agents/*`). Export it to your `superpowers` checkout before a run
(`export SUPERPOWERS_ROOT=/path/to/superpowers`). See the run-dir layout in §5.

### Where the verbs and helpers actually live

The scenario DSL — `file-exists`, `git-count`, `not`, `check-transcript`,
`setup-helpers` — is **not** a set of executables in a `bin/` directory. This
tree has no `bin/` or `bin-ts/`; treat any doc that says otherwise as stale.
The DSL entries are **shell functions** defined by `src/checks/prelude.sh`,
which quorum sources before every scenario script:

- For `checks.sh`, the prelude is `source`d directly inside `runPhase`'s
  `bash -c` (`src/checks/index.ts`).
- For `setup.sh`, the prelude is wired in via `BASH_ENV=<prelude>` so the
  non-interactive bash that runs the script sources it first
  (`src/setup-step.ts`).

Each function delegates to a TypeScript dispatcher: filesystem/git verbs to
`src/cli/check-tool.ts`, transcript verbs to `src/cli/check-transcript.ts`, and
fixtures to `src/setup-helpers/cli.ts`. The bare FS-verb *vocabulary* comes from
`FS_VERBS` in `src/check/dispatch.ts` via `src/cli/list-check-verbs.ts`; the
prelude loops over that output, so it cannot drift from the source. To see the
live list, run:

```
bun run src/cli/list-check-verbs.ts
```

---

## 2. Writing `story.md` and acceptance criteria

### Frontmatter

A minimal valid `story.md` needs `id` and `title` in the leading `---` block and
an `## Acceptance Criteria` heading. Optional frontmatter (`src/story-meta.ts`,
`src/scaffold.ts`):

| Key | Meaning | Source of truth |
|---|---|---|
| `quorum_tier` | `sentinel` \| `full` \| `adhoc`. Anything else fails validation. | `readQuorumTier`; `VALID_TIERS` in `src/scaffold.ts` |
| `quorum_max_time` | Per-scenario duration cap, e.g. `90m`, `30s`, `120`. Regex: `^\d+(ms|s|m|h)?$`. | `readQuorumMaxTime` |
| `status`, `tags` | Informational; `status` defaults to `ready`. | `readStoryStatus` |

#### Choosing a `quorum_tier`

The tier is a **batch filter**, not a behavior switch. It only decides whether
`quorum run-all --tier <t>` includes the scenario (`src/run-all/matrix.ts`;
precedence is directive > draft > tier). It defaults to `full`. Pick:

- **`sentinel`** — a fast, high-signal smoke meant to run on every quick sweep
  (e.g. a single skill-auto-triggering check). Keep these cheap and deterministic.
- **`full`** — the default; part of the comprehensive suite but not the fast lane.
- **`adhoc`** — a one-off or experiment you do NOT want a default `--tier full`
  batch to sweep up; run it explicitly by name.

### The body briefs a QA agent — it is not a task description

Write the story body as **2nd-person instructions to the Gauntlet-Agent**. Tell
it what role to play, the **exact message** to type to the Coding-Agent, how to
answer follow-up questions, and when to stop. Tell it not to paraphrase the
opening message. The Gauntlet-Agent launches with **only** the story
(`buildGauntletArgv` in `src/runner/index.ts` passes the story path; `checks.sh`
is not on its command line), so the success criteria must live in this prose.

### Acceptance Criteria are graded semantically by an LLM

The Gauntlet-Agent grades your ACs by reading prose and observing the run. A
good AC:

- **Names the exact evidence** and gives the grader the file path — e.g. "a
  `Skill` invocation naming `superpowers:requesting-code-review` appears in the
  session log."
- **Allows legitimate harness variants.** Claude loads a skill via a native
  `Skill` call; Codex greps `SKILL.md` via the shell. An AC that demands only the
  native form will false-fail Codex. (The transcript verbs already normalize this
  — see `isSkillInvocation` in `src/detect/skill.ts` and the `investigated` verb
  — and your prose should too.)
- **Pins ordering** where it matters — "before any implementation `Edit`/`Write`".
- **Closes rationalization escape hatches by name.** Forbid "looks good" / "ready
  to merge" approvals; set a severity floor ("Critical or Important, not Minor").
- **Distinguishes a partial pass** so the grader can score "fixed the bug but
  ignored the pushback" correctly.

### Run-completeness vs grade-completeness

State when the Gauntlet-Agent **stops driving**, independent of pass/fail.
Otherwise the grader leads the witness — it keeps prodding until it gets the
answer your ACs want. The pattern (from `code-review-catches-planted-bugs`):

> "Once the agent has produced a review … you are done. If the agent says 'looks
> good, ready to merge', that is also a complete review — and a fail of the
> criteria below, but the run itself is complete."

A wrong outcome can be a *complete run that fails*; do not conflate "the agent
gave the wrong answer" with "the run isn't finished."

### Fence every Gauntlet-Agent turn

The Gauntlet-Agent is an LLM and will improvise unless constrained. In the story,
script its replies: give the exact opening message, neutral canned responses to
clarifying questions, and explicit prohibitions ("Do NOT mention SQL injection";
"Do NOT volunteer anything about the planted bugs"; "respond neutrally — do not
insist on any item"). An unfenced grader contaminates the experiment.

### The elicited-fixture methodology

For skill-execution scenarios, where the agent executes a plan/spec, generate
the fixture plan with the skill under test. Do not hand-write it. Hand-authored
prose plans execute roughly **2× costlier** than real `writing-plans` output and
overstate the baseline. That attribution trap contaminates cost and behavior
measurements (methodology correction,
`docs/experiments/2026-06-10-sdd-cost-experiments.md`). The `*-elicited`
scenarios carry the realistic fixtures; default to them. Keep legacy hand-plan
variants only for longitudinal comparability.

### Belt-and-braces: assert the same fact twice

The strongest scenarios assert the same fact in **both** the AC prose (graded by
the LLM) and `checks.sh` (deterministic). The Gauntlet-Agent and the
post-checks are independent witnesses; agreement is a strong signal,
disagreement is a triage flag (Pattern 2 vs 4 in §5). `sdd-go-fractals-opus48`
is the model: its ACs say "builds, `go test ./...` passes, the work is on the
main checkout," and `checks.sh` independently runs `command-succeeds 'go test
./...'` and `git-count commits gte 4`.

### Cost scenarios are measurement instruments

A cost scenario's AC certifies **comparability** ("a real, runnable deliverable
that exercises the same surface"), not a dollar threshold. Captured token
economics hold the price; the AC keeps the two arms of a comparison honest.
Calibration pairs, such as `cost-checkbox-over-trigger` vs
`brainstorming-resists-jump-to-implementation`, bracket behavior from both
sides.

### Where the trigger lives: story prose vs fixture state

For an auto-triggering scenario, decide what the skill keys off, and put the
trigger there. Some skills key off the **conversation**:
`triggering-finishing-a-development-branch` fires on the request "I finished …
help me wrap it up and get it integrated," so its fixture is a bare
`create_base_repo` and the premise lives entirely in the story prose. Others key
off **repo state** — a skill about a feature branch only makes sense if `setup.sh`
actually leaves the fixture on a branch with commits ahead of `main`. Match the
fixture's git state to the story's premise: a story that says "I'm mid-rebase"
over a pristine `main` checkout gives the grader a contradiction and muddies the
result. When no helper builds the state you need, create it inline in `setup.sh`
with plain git commands (the git fixtures commit under the "Drill Test"
identity — see `src/setup-helpers/git.ts`).

### Anti-patterns

- Grading the agent's narration instead of its observable actions.
- Un-observable ACs (nothing in the transcript or filesystem can confirm them).
- Stop conditions tied to the verdict ("you are done when the agent passes").
- Harness-specific evidence that only one Coding-Agent can produce.
- Over-fitting to one implementation of a correct answer.

---

## 3. Writing `setup.sh` and fixtures

### `$QUORUM_WORKDIR` is the fixture root

`setup.sh` runs with cwd set to the workdir and `QUORUM_WORKDIR` exported to its
absolute path (`src/setup-step.ts`). The dir already exists — **never `mkdir`
it.** Build the fixture in place. (Reminder: `$QUORUM_WORKDIR` is
available in `setup.sh` only, never in `checks.sh`.)

The bare verbs and `setup-helpers` resolve via the `BASH_ENV`-sourced prelude,
**not** via `PATH`. There is nothing on `PATH` to install.

### The setup-helper catalog

Prefer a setup-helper over hand-rolled fixture shell. Invoke them via the bare
verb, chaining left-to-right in one process:

```
setup-helpers run create_base_repo add_existing_worktree detach_worktree_head
```

`REGISTRY` in `src/setup-helpers/registry.ts` is the dispatch table.
`KNOWN_HELPER_NAMES` is the validation set `quorum check` uses: the registry keys
plus two library-only names, `add_worktree` and `detach_head`. **Discover the
current list from there**; the catalog below pins each entry to its defining file
but is not the source of truth.

| Family / file | Representative helpers | Notes |
|---|---|---|
| base (`base.ts`) | `create_base_repo` (`needsTemplateDir`), `init_repo_from_fixtures` (`needsScenarioDir`), `record_head` | `create_base_repo` does `git init` and seeds from `fixtures/template-repo`. `init_repo_from_fixtures` git-inits and mirrors `scenarios/<name>/fixtures/` into the workdir. `record_head` writes the `assert-checkout-clean` sentinel. |
| spec (`spec-fixtures.ts`) | `create_spec_writing_blind_spot`, `create_spec_targets_wrong_component`, `add_flawed_spec_for_review` | `add_*` helpers layer onto an existing repo (no `git init`). |
| triggering (`triggering-fixtures.ts`) | `add_auth_execution_plan`, `create_writing_plans_skeleton` | |
| sdd (`sdd-fixtures.ts`) | `add_sdd_auth_plan`, `scaffold_sdd_broken_plan`, `scaffold_sdd_quality_defect_plan`, `scaffold_sdd_yagni_plan`, `scaffold_sdd_spec_constraint_plan` | Embedded-body helpers that write their plan inline. SDD file fixtures (`design.md`/`plan.md`) now live in `scenarios/<name>/fixtures/` and are seeded by `init_repo_from_fixtures`. |
| cost (`cost-fixtures.ts`) | `create_cost_checkbox_page`, `create_cost_clean_repo`, `create_cost_trivial_plan`, `create_cost_large_files` | |
| behavior (`behavior-fixtures.ts`) | `create_claim_without_verification`, `create_phantom_completion`, `create_review_pushback`, `create_code_review_planted_bugs` | |
| worktree / provisioning (`worktree.ts`) | `add_existing_worktree`, `detach_worktree_head`, `setup_pressure_worktree_conditions`, `create_caller_consent_plan`, `symlink_superpowers` (`needsSuperpowersRoot`), `link_gemini_extension` (`needsSuperpowersRoot`), `install_codex_superpowers_plugin_hooks` (`needsSuperpowersRoot`) | The provisioning helpers seed per-harness plugin installs. |

**Self-contained vs layering.** A self-contained helper (e.g. `create_base_repo`)
does its own `git init`. A layering helper (`add_*`) assumes a repo already exists
and must follow a repo-creating helper in the chain. Put them in the wrong order,
and the layering helper has nothing to write into.

**Declared needs.** `needsTemplateDir` resolves `fixtures/template-repo` (requires
`QUORUM_REPO_ROOT`, which the runner sets). `needsScenarioDir` resolves `scenarios/<name>/fixtures` (requires
`QUORUM_SCENARIO_DIR`, which the runner sets to the scenario directory). `needsSuperpowersRoot` resolves
`SUPERPOWERS_ROOT`. The git fixtures commit under the "Drill Test" identity
(`src/setup-helpers/git.ts`).

### `fixtures/` vs inline constants

Per-scenario static or skill-generated content (elicited `plan.md` / `design.md`,
planted source trees) lives in the scenario's own `scenarios/<name>/fixtures/`
directory and is seeded by `init_repo_from_fixtures`, which mirrors the whole
tree into the workdir and makes one commit. **Shared** content used across many
scenarios — the base template repo — stays under top-level
`fixtures/template-repo/` and is read by `create_base_repo`. Small fixed strings
live as inline constants in the helper. Hand-authoring a big plan inline
reintroduces the elicited-vs-handwritten cost trap (§2).

### The `.quorum-launch-cwd` sentinel

By default, the Coding-Agent launches in `$QUORUM_WORKDIR`. To launch it
**elsewhere**, such as inside a sibling worktree the fixture created, write the
absolute target path into `$QUORUM_WORKDIR/.quorum-launch-cwd`:

```bash
echo "${QUORUM_WORKDIR}-existing-worktree" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
```

`resolveLaunchCwd` (`src/runner/index.ts`) reads it. A sentinel naming a
**non-existent** path causes a hard runner error. The runner fails fast instead
of launching from an accidental directory. The sentinel is harness plumbing:
`assert-checkout-clean` ignores a
`?? .quorum-launch-cwd` line in `git status` (`src/check/fs-verbs.ts`).

### Restricting and gating

- **`# coding-agents: <csv>`** as a comment in the **first 21 lines of
  `checks.sh`** restricts the scenario to the listed agents
  (`parseCodingAgentsDirective`, `src/checks/index.ts`). A matched-but-empty
  directive (`# coding-agents: ,`) means **skip all agents**; a true absence means
  un-gated. (This directive lives in `checks.sh`, not `setup.sh`, but it governs
  which agents the scenario runs against.)
- **`requires-tool <name…>`** in `pre()` guards local toolchain dependencies, for
  example `requires-tool go`. A missing tool fails the pre-check, which the
  composer maps to **`indeterminate`** (env-missing), not `fail`; a machine
  without `go` correctly reads as "couldn't evaluate," not a false negative. This
  also covers interpreters a **post**-check shells out to. If a
  `command-succeeds` probe runs `node` or `python`, guard it with
  `requires-tool node` in `pre()` so a missing runtime reads as `indeterminate`,
  not a fake `fail`.

---

## 4. Writing `checks.sh`

`checks.sh` contains only function definitions:

- **`pre()`** runs after `setup.sh`, before the Coding-Agent. It asserts the
  fixture is exactly what the scenario assumes. A failed pre-check →
  **`indeterminate`** (the fixture was wrong; the run is uninterpretable). A
  pre-check **crash** → `indeterminate`, stage `checks`.
- **`post()`** runs after capture. It asserts the outcome. A failed post-check →
  **`fail`**. A post-check crash → `indeterminate`, stage `checks`.

quorum sources the same `checks.sh` for both phases; `pre` and `post` are the
functions it invokes.

### Two verb namespaces

1. **Filesystem / git / env verbs** — call these **bare** (`file-exists`,
   `git-count`, …). Source of truth: `FS_VERBS` in `src/check/dispatch.ts`,
   surfaced by `bun run src/cli/list-check-verbs.ts`.
2. **Transcript verbs** — always invoke these as **`check-transcript <verb>`**. Source
   of truth: the dispatch switch in `src/check/transcript-dispatch.ts` and the
   verb functions in `src/check/verbs.ts`. The composer's `TRACE_PRIMITIVES` set
   (`src/composer.ts`) must list the same verbs.

`not <inner> [args…]` wraps either namespace to invert it.

> The catalogs below are correct against the code they cite, but **the code is the
> source of truth** — regenerate the FS list with `list-check-verbs.ts` and read
> `transcript-dispatch.ts` for the transcript list before trusting a count.

#### FS / git / env verbs (`src/check/fs-verbs.ts`, registered in `dispatch.ts`)

| Verb | Args | Semantics |
|---|---|---|
| `file-exists` | `<glob>` | Pass iff ≥1 workdir-relative path matches. Supports a single `**` recursive segment plus single-segment `*`/`?`/`[…]`. A literal path matches iff it exists. With a no-slash suffix, `**` matches the **basename** at any depth **including the repo root** — so `file-exists '**/*.test.js'` also matches a top-level `foo.test.js`. Handy for "the agent left a test artifact *somewhere*." |
| `file-contains` | `<path> <ere>` | `grep -qE` semantics: file exists and ≥1 line matches the extended regex. |
| `command-succeeds` | `<command>` | `bash -c <command>` in the workdir; pass iff exit 0. On failure, the first 500 bytes of combined stdout+stderr become the detail. **Quoting:** the command travels through the prelude into `bash -c`; single-quote the outer command and escape inner double quotes (e.g. a `node -e "…"` probe), then smoke-test the exact string with `bash -c '<command>'` before committing. A quoting slip lands silently in the assertion/127 band. |
| `git-repo` | — | cwd is a git work tree. |
| `git-branch` | `<name>` \| `detached` | Current branch equals `<name>`, or HEAD is detached. |
| `git-clean` | — | `git status --porcelain` is empty. |
| `git-count` | `<commits\|worktrees> <op> <n>` | `op ∈ {eq, ne, gt, gte, lt, lte}`. `commits` = `rev-list --count HEAD`; `worktrees` = lines of `git worktree list` (includes main). Unknown dimension/op → **broken (127)**. |
| `assert-checkout-clean` | `<path>` | `<path>` is a clean work tree whose HEAD matches the recorded sentinel (`record_head`) if present; ignores `?? .quorum-launch-cwd`. |
| `requires-tool` | `<tool…>` | Every named tool is on PATH (executable). Use in `pre()` → missing = indeterminate. |
| `files-exist` | `<root> <rel…>` | Every `<rel>` is a regular file under `<root>`. |

Six **bootstrap verbs** take no args and read `QUORUM_AGENT_CONFIG_DIR` to assert
the Superpowers plugin staging in a harness's isolated config:
`antigravity-plugin-installed`, `copilot-plugin-installed`,
`opencode-plugin-installed`, `gemini-extension-linked`, `kimi-plugin-installed`,
`codex-native-hook-configured` (the last two carry extra structured checks; see
`fs-verbs.ts`).

`bootstrap-installed` is the cross-agent dispatcher over those six. It reads
`QUORUM_CODING_AGENT` (the coding-agent config name, exported to the checks
phase by the runner) and delegates to the matching per-harness verb. Claude
variants and pi have no dedicated install verb, so it passes for them — their
bootstrap is proven behaviorally — and an unknown agent fails. Use it in `pre()`
of an agent-agnostic scenario so a missing install reads as indeterminate
(fixture/harness breakage) rather than a behavior failure.

#### Transcript verbs (`src/check/verbs.ts`, dispatched in `transcript-dispatch.ts`)

| `check-transcript <verb>` | Args | Semantics |
|---|---|---|
| `tool-called` | `<tool>` | The tool was called ≥1 time. |
| `tool-not-called` | `<tool>` | **Negative.** Tool called 0 times; **empty capture → FAIL**. |
| `tool-count` | `<tool> <op> <n>` | `op ∈ {eq, ne, gt, gte, lt, lte}` (same ops as `git-count`). Unknown op → broken (127). |
| `tool-before` | `<a> <b>` | First `<a>` precedes first `<b>`; both must occur. |
| `skill-called` | `<skill>` | Skill loaded (native `Skill`, shell read of `SKILL.md`, or normalized `Read` — `isSkillInvocation`). |
| `skill-not-called` | `<skill>` | **Negative.** Empty capture → FAIL. |
| `skill-before-tool` | `<skill> <tool>` | Skill precedes the tool. **Vacuous-pass:** no `<tool>` call → pass. Empty capture → FAIL. |
| `skill-before-implementation-tool` | `<skill> <tool>` | Skill precedes the first *implementation-file* use of the tool. **Vacuous-pass** when there is no implementation call. "Implementation" excludes `.git`, `node_modules`, `docs/superpowers/`, `.gitignore`, `.antigravitycli` (`src/detect/implementation.ts`). |
| `implementation-tool-not-called` | `<tool>` | **Negative.** No implementation-file use of `<tool>`. Empty capture → FAIL. |
| `investigated` | — | A native `Read`/`Grep`, or a shell `grep`/`rg` via `Bash`, occurred (cross-harness). |
| `worktree-created` | — | `EnterWorktree`, or `git worktree add` via `Bash`. |
| `tool-match-before-tool-match` | `<toolA> <reA> <toolB> <reB>` | First `<toolA>` whose text matches `<reA>` precedes first matching `<toolB>`. **Vacuous-pass** when no `<toolB>` matches. Matches `args.command` if present, else compact JSON of args. |
| `tool-arg-match` | `<tool> [--eq key=value]… [--matches key=regex]… [--ignore-case]` | There exists a `<tool>` call whose args satisfy **all** matchers. Keys support `,`-separated fallback (`path,file_path`); split on first `=`. Needs ≥1 `--eq`/`--matches` with a non-empty key, else broken (127). Positive existence check — empty capture fails naturally. |

#### `not` — three load-bearing rules (`negate` in `dispatch.ts`)

1. On a normal inner pass/fail, it emits **one** record on the inner's behalf
   (`check=<inner>`, `negated:true`, inverted `passed`).
2. It **refuses to invert a missing inner verb** — records a FAIL under `not` and
   exits **1** (an honest failed check, not 127).
3. It **refuses to invert a crash** (the inner returned broken / threw) — same as
   rule 2.

So `not <typo>` and `not <broken-check>` fail honestly rather than vacuously
passing. `not` works on both namespaces, e.g.
`not check-transcript tool-arg-match Bash --matches 'command=git worktree add'`.

### Designing a check that discriminates

A behavior/quality scenario lives or dies by a deterministic check that separates
a **correct** fix from a **plausible-but-wrong** one — not merely "does it work."
The trap: an end-to-end check (`command-succeeds 'the output is right now'`)
passes for a symptom patch that papers over the real defect. **Probe the
component you actually care about, directly**, not only the final output.

In `systematic-debugging-fixes-root-cause`, the end-to-end price is correct under
*both* a real root-cause fix and a consumer-side guard, so the e2e check cannot
tell them apart. The discriminating check calls the upstream producer directly:
`command-succeeds 'node -e "… getDiscountRate(\"BOGUS\") is a real number …"'`.
A symptom-only patch leaves that call returning `undefined`. Pair the
deterministic discriminator with AC prose stating the same distinction, and
**hand-verify the discriminator against all three states**: broken, symptom-only,
and root-cause. A check that cannot fail the wrong-but-plausible fix is Pattern 4
waiting to happen.

### The record model

Every verb emits **one** JSON record to `QUORUM_RECORD_SINK`
(`src/check/record.ts`): `{check, args, negated, passed, detail}`. The `phase`
(`pre`/`post`) comes from quorum, not the verb (`src/checks/index.ts`). The
record's `check` field is the **sub-verb** name (e.g. `skill-called`), never the
wrapper `check-transcript`. An empty detail (`''`) is normalized to `null`.

### Exit codes: assertion-fail (1) vs broken-check (127)

| Exit | Meaning | Invertible by `not`? |
|---|---|---|
| `0` | check passed | — |
| `1` | check failed its assertion | yes |
| `127` | **broken check**: usage error, unknown verb, missing required arg, unknown operator/dimension, or a thrown tool error | **no** — in `not`'s crash band on purpose |

A typo'd or under-specified check lands in the 127 band, so it can neither
vacuously pass nor invert into a silent pass
(`src/cli/check-tool.ts`, `src/cli/check-transcript.ts`).

### Crash vs assertion at the phase level

`runPhase` (`src/checks/index.ts`) decides whether a whole phase **crashed**:

- rc `0` → ok.
- rc `126`/`127`/`≥128` → crash.
- rc `1..125` → ok **iff** ≥1 record was emitted, else crash.
- A signal-kill (status null + signal) is **always** a crash, even with partial
  records.

A crashed pre-phase or post-phase becomes `indeterminate`, stage `checks`; it
never becomes `fail`.

### The environment available to checks

`runPhase` builds the child env (`src/checks/index.ts`); checks see:

| Var | When | Use |
|---|---|---|
| `QUORUM_REPO_ROOT` | always | the prelude resolves the dispatchers from it |
| `QUORUM_RECORD_SINK` | always | where records are appended |
| `QUORUM_AGENT_CONFIG_DIR` | always | the Coding-Agent's isolated config dir (bootstrap verbs) |
| `QUORUM_TRANSCRIPT_PATH` | **post only** | the captured `trajectory.json` (transcript verbs load it) |
| `QUORUM_RUN_DIR` | **post only** | the run dir, for reading sibling artifacts |
| `$QUORUM_WORKDIR` | **never** | checks run with **cwd = the workdir**; use workdir-relative paths. Referencing it is a hard `quorum check` failure. |

For sibling run artifacts in a post-check, use `$QUORUM_RUN_DIR`; do not guess a
relative path up out of the workdir.

### Vacuous-pass verbs and empty capture

Three verbs **pass when their precondition is absent** because the "before"
anchor never fired: `skill-before-tool`, `skill-before-implementation-tool`, and
`tool-match-before-tool-match`. This is by design: "X before Y" is vacuously true
when there is no Y. Pair them with a positive verb (e.g. `skill-called`) when you
need to assert the skill *did* fire.

Conversely, the **negative** transcript verbs (`tool-not-called`,
`skill-not-called`, `implementation-tool-not-called`, and the empty-guarded
`-before` verbs) treat an **empty capture as FAIL**, so a run that captured
nothing cannot pass a "didn't call X" assertion. The composer also forces
`indeterminate` when the capture was empty and **any** `TRACE_PRIMITIVES` check
ran (`src/composer.ts`). An empty transcript makes every trace check meaningless.

---

## 5. Debugging a non-passing run

### Start with `quorum show`

```
bun run quorum show [<target>]
```

`resolveTarget` (`src/cli/resolve-target.ts`): a bare invocation shows the newest
run; a scenario name matches `results/<name>-*` (newest); an explicit dir must
contain `verdict.json`; a batch id resolves under `results/batches/<id>`. Read the
header (`final`, `final_reason`), the Gauntlet pane, and the checks pane
(`src/cli/render.ts`).

### The verdict decision tree (composer precedence)

`compose` (`src/composer.ts`) evaluates **in this order**. The first match wins;
this is precedence, not voting:

1. `error != null` → **indeterminate** (stage one of `setup | gauntlet | capture |
   checks | compose | qa-agent-misconfigured | stopped | unknown` —
   `RUN_ERROR_STAGES` in `src/contracts/verdict.ts`).
2. any failed **pre**-check → **indeterminate** (the Gauntlet-Agent may still be
   `pass`; the fixture was wrong).
3. no Gauntlet verdict → **indeterminate**.
4. Gauntlet `investigate` or `errored` → **indeterminate**.
5. empty capture **and** any `TRACE_PRIMITIVES` post-check ran → **indeterminate**.
6. Gauntlet `pass` **and** zero failed post-checks → **pass**.
7. otherwise → **fail** (Gauntlet non-pass, or ≥1 failed post-check).

Key consequence: **`gauntlet.status == pass` can co-occur with
`final == indeterminate`** (rows 1–5). Read `final` and `final_reason`, not just
the Gauntlet pane.

### Then the attribution atlas

`docs/superpowers/skills/triaging-a-failing-eval.md` enumerates **7 patterns**.
The hardest call is **Pattern 2 (real defect the judge missed) vs Pattern 4
(broken check)**. Both present as `final=fail` with `gauntlet=pass` and a failing
post-check. Distinguish them by **re-running the check on a known-good fixture**:
if it still fails, the check is broken (Pattern 4); if it passes, the defect is
real (Pattern 2).

### Common authoring traps (and which verdict they produce)

- **Exec-bit asymmetry.** `checks.sh` executable, or `setup.sh` not → setup/checks
  failure.
- **127 crash-band.** A typo'd or under-specified check crashes the phase →
  checks-stage `indeterminate`, *not* a `fail`. (Don't mistake it for a real
  negative.)
- **Empty capture poisons trace checks** → capture-stage `indeterminate`. The
  runner re-diffs up to 3× to absorb a flush race before declaring empty. Strict
  backends (`STRICT_CAPTURE_NAMES = {antigravity, claude, copilot, gemini}` in
  `src/runner/index.ts`) emit a loud, *named* indeterminate ("no Claude
  transcript … / normalized to zero rows") rather than a silent zero.
- **`$QUORUM_WORKDIR` in `checks.sh`** → caught by `quorum check`; checks run with
  cwd = workdir, so use relative paths.
- **Missing `requires-tool` pre-guard** turns an env-missing condition into a fake
  `fail` (Pattern 4) instead of a clean `indeterminate` (Pattern 3). Guard
  toolchain deps in `pre()`.
- **Guessing sibling-artifact paths** instead of using `$QUORUM_RUN_DIR`.
- **Agent-restriction mismatch** — a `# coding-agents:` directive that excludes the
  agent you ran shows an indeterminate "requires coding-agents: …".
- **Index-tie ordering.** `tool-before` / `tool-match-before-tool-match` compare
  list indices; a single compound `pytest && git commit` Bash call yields equal
  indices and reads as "commit not after pytest." Note it for triage (see
  `verification-phantom-completion`).

### Run-dir layout

A run dir (`results/<scenario>-<agent>-<os>-<stamp>-<nonce>/`) holds:
`verdict.json` (the composed verdict, schema `src/contracts/verdict.ts`);
`trajectory.json` (the normalized ATIF transcript — what transcript verbs read);
`coding-agent-token-usage.json` (priced usage, when obol can price);
`coding-agent-workdir/` (the files the agent wrote);
`home/` (the Coding-Agent's throwaway `$HOME`, including config and session
logs); and `gauntlet-agent/` (the QA agent's `results/<runId>/run.jsonl` event
stream plus `result.{json,md}`). Batches live
under `results/batches/<id>/` (`batch.json` + `results.jsonl`).

---

## 6. Worked examples

### Trivial smoke — `scenarios/00-quorum-smoke-hello-world`

The minimum viable scenario: one helper, two FS checks. `setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo
```

`checks.sh`:

```bash
pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'hello.txt'
    file-contains hello.txt 'hi'
}
```

### Skill auto-triggering — `scenarios/triggering-test-driven-development`

The story omits the skill name ("Do not mention TDD … or any superpowers
concept"). This scenario asks whether the skill **auto-triggers**. The AC pins
ordering and allows all three skill-loading forms. `post()`:

```bash
post() {
    check-transcript skill-called superpowers:test-driven-development
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Edit
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Write
}
```

`skill-called` is the positive anchor; the two `skill-before-implementation-tool`
checks are vacuous-pass if the agent never edited/wrote an implementation file;
the positive check carries the weight.

### Judgment / quality — `scenarios/code-review-catches-planted-bugs`

A spec-aware story names `superpowers:requesting-code-review`, so the scenario
tests **review quality**, not triggering. The `pre()` asserts the planted fixture
before grading the outcome:

```bash
pre() {
    git-repo
    git-branch main
    git-count commits eq 2
    file-exists 'src/db.js'
    file-contains src/db.js '\+ email \+'
    file-contains src/db.js 'function hash\(s\) \{[[:space:]]*return s'
}

post() {
    check-transcript skill-called superpowers:requesting-code-review
    check-transcript tool-called Agent
}
```

The hard, judgment-heavy criteria, such as the severity floor and "did not
approve for merge," live in the **AC prose** for the Gauntlet-Agent; `checks.sh`
only confirms that the skill fired and a reviewer subagent was dispatched.
`receiving-code-review-pushback` is the companion judgment scenario, layering
`check-transcript investigated` and several `not file-contains` / `not file-exists`
checks to assert the agent declined the bad suggestions without applying them.

### The launch-cwd sentinel — `scenarios/worktree-detached-head-external`

Chain three helpers, then point the launcher at the sibling worktree:

```bash
#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo add_existing_worktree detach_worktree_head
# add_existing_worktree creates ${QUORUM_WORKDIR}-existing-worktree as a
# sibling; detach_worktree_head leaves it on a detached HEAD. Point the
# runner at it via the launch-cwd sentinel.
echo "${QUORUM_WORKDIR}-existing-worktree" > "${QUORUM_WORKDIR}/.quorum-launch-cwd"
```

Its `pre()` reaches the sibling with `command-succeeds 'git -C
../coding-agent-workdir-existing-worktree …'`. Because cwd is the workdir, the
sibling is one level up. `post()` asserts `git-count worktrees eq 2`; the agent
must **not** create a third worktree.

### Belt-and-braces — `scenarios/sdd-go-fractals-opus48`

The deliverable scenario has an elicited plan, a long `quorum_max_time: 90m`, and
ACs that demand a real, runnable project on the main checkout. `checks.sh`
independently gates every claim:

```bash
post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-exists '**/*_test.go'
    command-succeeds 'go test ./...'
    file-exists 'cmd/fractals/main.go'
    git-count commits gte 4
}
```

(`requires-tool go` lives in `pre()`, so a machine without Go yields
`indeterminate`, not a false `fail`.) The AC prose asserts the same facts in
words, so the Gauntlet-Agent and deterministic checks corroborate each other.
Disagreement between them is a triage signal.

# Harness Model — Design Specification

**Status:** Specification, ready for implementation planning. Pending Matt's
sign-off. Not yet implemented.
**Date:** 2026-05-22
**Supersedes:** the working draft `docs/harness-model.md` and the research note
`docs/eval-failure-ergonomics.md` (both deleted).

**Frame.** The Drill→Gauntlet migration reached parity. This spec is the next
step: making the *result* good to use rather than scaffolding built over the
previous thing. It redesigns how a scenario expresses its deterministic checks,
how a run's verdict is shaped, and how a run directory is laid out — so that
*figuring out why an eval did not pass* stops being archaeology.

This spec covers the **model**: scenario layout, the deterministic check system,
the verdict, the run directory, and the runner changes. Triage-surfacing tooling
(`harness show`, a triage skill) is a deliberate **follow-on spec** (§15).

---

## 1. Canonical actors — who, what, where

Keep the actors straight; confusing them is the most common triage error. These
names are used everywhere — docs, CLI output, code, filenames, commit messages.
§13 puts this table verbatim into `README.md` and `CLAUDE.md`.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM *inside* Gauntlet that drives the system-under-test and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream → `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict → `result.{json,md}` |
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Codex**; future **Gemini**, **Pi**. | session log → `<run>/coding-agent-config/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Harness** | The Python wrapper. Owns setup, Coding-Agent adaptation, the deterministic checks, and the final verdict. | repo `superpowers-evals/harness/`; `<run>/verdict.json` |

A run involves **two** LLMs — the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, separate logs, separate token costs.

---

## 2. Motivation

A non-passing run is hard to triage because `final: fail` names nothing. A
multi-scenario eval of ~17 real failures found six shapes:

| Shape | Frequency | The real triage question |
|---|---|---|
| Gauntlet-Agent **pass**, a check **fails** | ~9 | which judge is right? |
| Gauntlet-Agent **fail**, all checks **pass** | ~1 | is the AC itself sound? |
| Gauntlet-Agent **fail**, a check **fails** | ~5 | both agree — what did the Coding-Agent do wrong? |
| Gauntlet-Agent **investigate** | ~1 | is the run even valid? |
| no `verdict.json` at all (run crashed) | ~5 | what broke before the verdict? |

Behind every shape: a run produces several judgments, and one flat word hides
which of five actors is at fault — the Coding-Agent (a real finding), the
Gauntlet-Agent (misjudged), a deterministic check (badly written), the Harness
(infra broke), or the AC/story (ambiguous). **Triage is attribution.** This spec
makes the verdict structured, and the run directory legible, so attribution falls
out of the data.

Worked example — the run that triggered this work: `cost-spec-plan-duplication`
reported `FAIL: no plan doc`. The truth: the Gauntlet-Agent looped and never
asked the Coding-Agent for the plan — an *invalid run*, not a failing eval. The
model below makes that legible as `final: indeterminate` with a reason, instead
of laundering it into `fail`.

---

## 3. Design principles

The *why* behind the spec; settled across the design conversation.

- **P1 — Gauntlet = act + assert; Harness = arrange + adapt + consume.**
  Gauntlet is a black-box tester: it drives the SUT and observes three surfaces
  it emits — the **screen**, the **logs**, the **artifacts** (files, git state,
  exit codes). The Harness does *not* re-judge; it builds the world (setup),
  knows the Coding-Agents (launch & log adaptation), runs the deterministic checks, and
  composes the final verdict. Gauntlet will **not** grow its own deterministic
  path.

- **P2 — Acceptance Criteria stay pure subjective prose.** ACs live in
  `story.md`, are read only by the Gauntlet-Agent, and are judged semantically.
  They are never reshaped to be machine-checkable.

- **P3 — Deterministic checks are an independent, parallel path.** They are
  *outcome facts*, not the verification mechanism of any AC. They may overlap an
  AC's territory (a useful cross-check); nothing binds them. The discipline is
  **narrowness** — checks target *outcomes* (a file exists, a build passes), not
  *implementation* (DOM selectors). For a skill-compliance benchmark, "skill X
  fired" is a legitimate outcome; the coupling smell appears only when an AC's
  intent is broader than a specific pinned skill.

- **P4 — One file, one metaphor; the directory is the scenario.** A scenario is
  the directory `harness/scenarios/<name>/`. Inside it, each file is a single
  mode. Gauntlet only ever sees `story.md`; the Harness owns the rest.

- **P5 — Checks are a bash script over a vocabulary of `harness/bin/` tools.** An
  earlier draft made checks a declarative YAML vocabulary. It was abandoned: the
  vocabulary immediately accreted negation, comparison operators, and an embedded
  query language — a programming language inside YAML, the classic mistake. The
  decision: use the language we already have. The checks file is a real bash
  script; the vocabulary is the Harness's own `harness/bin/` directory.
  Narrowness becomes a *soft*
  discipline — the tools are the path of least resistance, check scripts are
  short and reviewed — not a hard format constraint. The structured per-check
  verdict is preserved by tools self-reporting records (§7), not by parsing.

---

## 4. Scenario layout

A scenario is the directory `harness/scenarios/<name>/`.

**Today:**

```
harness/scenarios/<name>/
├── story.md              Gauntlet — prose + ## Acceptance Criteria
├── setup.sh              Harness  — builds the fixture
├── preflight.sh          Harness  — fixture invariants (bash)
├── assertions/           Harness  — post-run checks (one bash file each)
│   ├── 01-spec-doc-produced.sh
│   └── 02-plan-doc-produced.sh
└── scenario.yaml         optional — compatible_targets
```

**Proposed:**

```
harness/scenarios/<name>/
├── story.md              Gauntlet — the story: prose + ## Acceptance Criteria
├── setup.sh              Harness  — builds the fixture (unchanged)
└── checks.sh             Harness  — pre() + post() deterministic checks (bash)
```

- `story.md` is the **Gauntlet story** — "story" is Gauntlet's own term for its
  prose test card (frontmatter + narrative + ACs). The *directory* is the
  *scenario*; the *story* is the Gauntlet-facing prose within it.
- `preflight.sh` and the `assertions/` directory are **removed** — both fold into
  `checks.sh` (§7).
- `scenario.yaml` is **removed**. Its sole content, `compatible_targets`,
  becomes a `# coding-agents:` magic comment at the top of `checks.sh` — see §9.

---

## 5. The run directory

Each run produces one directory under `results-harness/`. Today's layout hides
the richest evidence behind a dotdir, scatters the Coding-Agent's output to a
`/tmp` path, and gives no clue which file belongs to which actor.

**Today:**

```
results-harness/<scenario>-<coding-agent>-<timestamp>/
├── verdict.json
├── token_usage.json
├── tool_calls.jsonl
├── workdir-path.txt          → /var/folders/.../harness-wd-XXXX  (the real output, elsewhere)
├── agent-config/
└── .gauntlet/                ← hidden dotdir
    └── results/<runId>/ ...
```

**Proposed** — every entry prefixed by the actor it belongs to (P1, P4):

```
results-harness/<scenario>-<coding-agent>-<timestamp>/
├── verdict.json                    the composed result — the front door (unprefixed)
├── gauntlet-agent/                 the Gauntlet-Agent's evidence (was .gauntlet/)
│   └── results/<runId>/
│       ├── result.{json,md}        the Gauntlet-Agent's verdict
│       ├── run.jsonl               the Gauntlet-Agent's event stream
│       ├── inputs/story.md
│       └── captures/
├── coding-agent-workdir/           the Coding-Agent's actual file output
├── coding-agent-config/            the Coding-Agent's isolated config home
├── coding-agent-tool-calls.jsonl   the Coding-Agent's normalized trace
└── coding-agent-token-usage.json   the Coding-Agent's token cost
```

`verdict.json` stays unprefixed — it is the one composed answer, the file you
open first; everything else is evidence, sorted by whose it is. A bare `ls` of a
run dir now tells you what happened and whose each artifact is.

Renames: `.gauntlet/` → `gauntlet-agent/` (via Gauntlet's existing `--state-dir`
flag, §10.4); `agent-config/` → `coding-agent-config/`; `workdir` moves in from
`/tmp` as `coding-agent-workdir/`; `tool_calls.jsonl` →
`coding-agent-tool-calls.jsonl`; `token_usage.json` →
`coding-agent-token-usage.json`. (`-` vs `_` is not load-bearing; `-` chosen for
consistency.)

**Two unprefixed-but-related entries** appear for worktree scenarios:
`coding-agent-workdir-existing-worktree/` and `coding-agent-workdir-codex-home/`,
created by `setup_helpers/worktree.py` as siblings of the workdir. They share
the `coding-agent-workdir` stem so they read as fixture extensions, but they do
not strictly carry an actor prefix — a known exception to the §5 invariant.

**Codex-specific:** the seeded `auth.json` (written by `_seed_codex_auth` for
codex runs) lands inside `coding-agent-config/`. `results-harness/` is
gitignored, so it never leaks; the runner docstring at `runner.py:64` explains
the rationale.

---

## 6. The check vocabulary

The vocabulary is **`harness/bin/`** — the Harness's own directory of small
tools, each performing one narrow check. To see the vocabulary, `ls harness/bin/`.
To add to it, add a tool. There is no separate "primitive vs. escape hatch"
distinction: every check is a `harness/bin/` tool call; a bespoke need is simply
a more capable tool, called the same flat way.

Grouped by observation surface (P1) — the ~14 concepts from the check census:

**Artifact surface** — the filesystem the Coding-Agent produced
- `file-exists <glob>` — a path matching the glob exists
- `file-contains <path> <regex>` — the file exists and matches the regex
- `command-succeeds <cmd>` — the command, run in the workdir, exits 0 (for the
  project's own build/test — `go test ./...`, `npm test` — not a generic
  predicate; a `command-succeeds 'grep …'` standing in for `file-contains` is a
  review failure)

**Git surface** — git state the Coding-Agent shaped
- `git-repo` — the workdir is a git work tree
- `git-branch <name>` — current branch == name (`detached` for detached HEAD)
- `git-clean` — the working tree has no uncommitted changes
- `git-count worktrees|commits <op> <n>` — the count satisfies the comparison
  (`worktrees` counts `git worktree list`, main worktree included)

**Trace surface** — the Coding-Agent's normalized tool-call log
(`coding-agent-tool-calls.jsonl`)
- `tool-called <tool>`, `tool-count <tool> <op> <n>`, `tool-before <a> <b>`,
  `tool-arg-match <tool> <jq>` — and the regex-ordering tools
  `tool-match-before-tool-match`, `skill-before-tool-match`
- `skill-called <skill>`, `skill-before-tool <skill> <tool>`

**Negation**
- `not <check> [args…]` — runs the inner check with `HARNESS_RECORD_SINK` unset
  (so the inner emits no record), captures its exit, and emits one record via
  the shared `_record` helper with `negated: true` and `passed` inverted (see
  §7 for the full mechanism). Authors use `not`, never bash's bare `!` (which
  would flip the script's exit but leave a misleading record).

`harness/bin/` is the Harness's own check-tool directory. It is **forked** from
the shared top-level `bin/` — the trace tools are copied as a one-time starting
point; the artifact, git, and `not` tools are added new; all tools then source
a shared `harness/bin/_record` helper (§7) that gives them the record-emission
behavior. After the fork the two directories are **independent**; they share no
code. The shared `bin/` (used by Drill) is left **frozen and untouched** — Drill
never sets `HARNESS_RECORD_SINK`, so the env-var-conditional contract cannot
disturb it; `bin/` is removed when Drill is decommissioned. `capture-non-empty`
and Coding-Agent gating are runner machinery, not scenario-authored tools — see
§9.

---

## 7. The checks script

`checks.sh` is a **real bash script** — executed, not parsed. It defines two
functions:

```bash
# harness/scenarios/cost-spec-plan-duplication/checks.sh
# Sourced by the Harness. pre() runs before the Coding-Agent; post() after.

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'docs/superpowers/specs/*.md'
    file-exists 'docs/superpowers/plans/*.md'
    skill-called superpowers:brainstorming
    not file-contains index.html checkbox
}
```

**How it runs.** The Harness invokes `bash -c 'source checks.sh; pre'` with
`cwd = coding-agent-workdir/`, `harness/bin/` on `PATH`, and a record-sink path in the
environment — once for `pre` (before the Coding-Agent) and once for `post`
(after capture). Run via `bash <path>`, so there is no shebang ceremony and no
executable bit (the exec-bit footgun stays dead).

**The record contract.** Each `harness/bin/` tool emits **exactly one** JSON
record per invocation by sourcing a shared helper, `harness/bin/_record`. The
helper exposes `record_pass`, `record_fail`, and `record_negated` functions and
reads three things from the tool's own context: the env var `HARNESS_RECORD_SINK`
(an absolute file path the runner sets), `$0` (→ `check = basename "$0"`), and
`"$@"` (→ `args` as a JSON array; the helper handles JSON quoting). The Harness
reads the sink after each phase and assembles the verdict's `checks[]` (§8).
The **verdict is built from the records** — not from the script's exit code,
not from a parse.

The helper is **mandatory**. Hand-rolled JSON emission in 14+ tools is the
"shared-zero-code" trap that produces fragile, inconsistent records. Every tool
sources `_record`; `_record` installs an `ERR` trap so that **any internal tool
failure** (a missing dependency like `jq`, a malformed call, a bad regex) still
emits one record — `{passed: false, detail: "tool error: <reason>"}` — before
propagating. The contract is therefore *total*: one invocation, one record,
always. Tools never silently drop out of the verdict.

The runner uses the script's **exit code as a crash signal, not a pass/fail
signal.** A non-zero exit from `bash -c 'source checks.sh; pre'` (a source
failure, an undefined function, a runtime syntax error) yields `final:
indeterminate` with `error.stage = checks` — the records cannot be trusted on a
script that did not run to completion. On a normal run the script exits 0
regardless of which individual checks passed or failed (no `set -e`); pass/fail
comes from the records alone. This closes the laundering hole: a tool crash
either emits a record (via the ERR trap) **or** trips the non-zero-exit gate.

**Consequences, pinned:**
- **No `set -e`.** A failing check must not abort the script — every check runs
  and reports. The `_record` ERR trap guarantees a record even if a tool's body
  crashes.
- **`not` is a vocabulary tool**, not bash `!` (§6). Mechanism: `not <inner>
  [args…]` runs the inner tool with `HARNESS_RECORD_SINK` unset (suppressing
  the inner's record), captures its exit, and calls `record_negated` to emit
  `{check: <inner-tool-name>, args: <inner-args>, negated: true, passed:
  <inverted exit>, detail: null}`. `not` itself sources `_record`.
- **Concurrency is unsupported.** `_record` appends serially; the contract
  assumes flat, sequential execution. Background invocations (`&`) are not
  supported and `harness check` warns on them.
- A real script *can* contain a loop or an `if`; legal bash, records reflect
  exactly what ran. The census shows checks are flat one-liners — this is left
  to authoring judgment, not a format constraint (P5).
- `harness check` (§11) runs `bash -n checks.sh`, confirms the file is
  **functions-only** (no top-level statements outside `pre`/`post` apart from
  the optional `# coding-agents:` magic comment, §9), confirms both `pre()` and
  `post()` are defined, and soft-lints for direct calls to non-vocabulary
  commands. The lint matches whole *command tokens* (not arguments) so
  `command-succeeds 'grep …'` does not false-positive on a quoted `grep`.

---

## 8. The verdict

### 8.1 `verdict.json` schema

Every run writes exactly one `verdict.json` to the run dir — including runs that
crash (§10.3).

```json
{
  "schema": 1,
  "final": "indeterminate",
  "final_reason": "Gauntlet-Agent did not complete (status: investigate)",
  "gauntlet": {
    "status": "investigate",
    "summary": "LLM returned neither tool call nor text",
    "reasoning": "Empty response on turn 149 ..."
  },
  "checks": [
    {"check": "git-repo",    "args": [],                          "negated": false,
     "phase": "pre",  "passed": true,  "detail": null},
    {"check": "file-exists", "args": ["docs/.../plans/*.md"],      "negated": false,
     "phase": "post", "passed": false, "detail": "no path matched"}
  ],
  "error": null
}
```

- `schema` — schema version; `1` for this spec.
- `final` ∈ `pass | fail | indeterminate` (§8.2).
- `final_reason` — always present; one line explaining the `final` value. The
  field a triage reader starts from.
- `gauntlet` — the Gauntlet-Agent layer: `status`
  (`pass | fail | investigate | errored` — Gauntlet's own vocabulary, passed
  through verbatim), `summary`, `reasoning`, and `run_id` (the matching
  subdirectory under `gauntlet-agent/results/`, for triage handoff). `null` if
  Gauntlet produced no result.
- `checks` — the deterministic layer: one entry per emitted record — `check`,
  `args`, `negated`, `passed`, `detail` (always present; `null` when empty),
  with `phase` (`pre`|`post`) **stamped by the runner** (`checks.py` knows
  which function it called) rather than emitted by the tool itself.
- `error` — populated only when the Harness itself failed:
  `{stage, message}`, `stage` ∈ `setup | gauntlet | capture | checks | compose |
  unknown`. `null` on a normal run.

The Harness `final` and the Gauntlet-Agent `status` use **distinct vocabularies**
on purpose — `indeterminate` vs `investigate` — so the two layers never collide
in conversation or in logs.

### 8.2 Composing `final`

```
final = indeterminate   if the run did not produce trustworthy data:
                           • setup.sh failed, or
                           • any pre-check failed, or
                           • gauntlet.status ∈ {investigate, errored}, or
                           • the capture-non-empty built-in failed, or
                           • the Harness crashed before composing.
      = pass            else, if gauntlet.status == pass
                               AND every post-check passed.
      = fail            else.
```

"Every post-check passed" is **vacuously true** when a scenario has no
post-checks; such a run is `pass` iff the Gauntlet-Agent passed. The rule is
total: exactly one branch applies to any combination.

The discipline that ships with it: **only `pass` means "move on."** A `fail` is
never a yawn — it still needs attribution (§2): a bad AC, a bad check, or a bad
story as readily as a real Coding-Agent failure. `indeterminate` means the run is
suspect — *no data, re-run* — not "the Coding-Agent failed." On an
`indeterminate` run the `checks` are still recorded but advisory: they ran
against a workdir the Coding-Agent may never have had a fair shot at.
`final_reason` always states which branch fired and why.

Exit codes: `pass` → 0, `fail` → 1, `indeterminate` → 2 (a sweep script can
branch on `indeterminate` without parsing JSON).

---

## 9. `capture-non-empty` and Coding-Agent gating

Two pieces of runner machinery that look like checks but live outside the
scenario's `checks.sh`:

- **`capture-non-empty`** is a **runner built-in**. After `post()` runs, the
  runner inspects the emitted records: if any record's `check` is a
  trace-surface tool (`tool-called`, `tool-count`, `tool-before`, `tool-arg-match`,
  `skill-called`, `skill-before-tool`, …) **and** `coding-agent-tool-calls.jsonl`
  is empty, `final` becomes `indeterminate` (an empty trace makes those checks
  meaningless). For pure file/git scenarios — no trace checks — the built-in
  does not fire; an empty trace is fine. This narrows Drill's old
  "any-assertion-at-all" empty-capture guard to "any *trace* check," and avoids
  marking pure-filesystem scenarios indeterminate on a legitimately quiet trace.

- **Coding-Agent gating** is declared via a **magic comment** at the top of
  `checks.sh`:

  ```bash
  # coding-agents: codex
  ```

  (Comma-separated for multi-agent compatibility, e.g. `# coding-agents: codex,
  gemini`.) The runner extracts this line from `checks.sh` *as text, before
  sourcing anything*. If the run's Coding-Agent is not in the list, the run
  bails immediately: `final: indeterminate`, `final_reason: "requires
  coding-agents: codex"`. No fixture is built, no script is sourced, no temp
  dir is wasted. A sweep discounts `indeterminate`, so an incompatible
  scenario/Coding-Agent combination lands correctly without a dedicated
  `skipped` status. Scenarios without the comment are compatible with every
  Coding-Agent — the default. The magic comment is the **only** directive the
  runner extracts from `checks.sh` ahead of execution; everything else is
  bash, sourced and called.

---

## 10. Runner & CLI changes

### 10.1 Workdir lives in the run dir

Today the workdir is `tempfile.mkdtemp()` in `/var/folders`; on a non-pass the
runner keeps the directory *and* writes a `workdir-path.txt` pointer, on a pass
it `rmtree`s it. The directory is not lost on failure — but it is not co-located
with the evidence, and a long-lived kept dir can still be reaped by OS temp-GC.

**Change:** the workdir is `<run>/coding-agent-workdir/`, created directly.
- The Coding-Agent's output is always co-located with the evidence, never
  garbage-collected, immediately greppable.
- **Deleted:** the `tempfile` allocation, `workdir-path.txt`, and the
  keep-on-fail / wipe-on-pass branching. The workdir is simply always present.
- **Blast radius, confirmed:** `_resolve_launch_cwd` and the `.harness-launch-cwd`
  sentinel key off the workdir wherever it is; `filter_codex_logs_by_cwd` /
  `filter_pi_logs_by_cwd` key off `launch_cwd`; both continue to work. Worktree
  scenarios that create a sibling now place it under `<run>/` next to
  `coding-agent-workdir/`, still gitignored via `results-harness/`.

### 10.2 The check step replaces assertions + preflight

`pre()` runs after `setup.sh`, before `invoke_gauntlet`; a failed pre-check →
`final: indeterminate`. `post()` runs after capture, before compose. A new
`harness/checks.py` sources `checks.sh`, runs the phases, and reads the records.
`harness/assertions.py` and the `preflight` half of `harness/setup_step.py` are
removed; `harness/composer.py` is rewritten for the §8 verdict.

### 10.3 Every run writes a verdict

`run_scenario` is wrapped so any failure — setup, Gauntlet, capture — is caught
and written as `verdict.json` with `final: indeterminate` and a populated
`error`. A run dir without a verdict becomes impossible, barring a crash inside
the verdict-writer itself.

### 10.4 Un-hide and name Gauntlet's output

`invoke_gauntlet` passes Gauntlet's existing `--state-dir gauntlet-agent` flag,
so the evidence lands in `<run>/gauntlet-agent/` instead of the hidden
`<run>/.gauntlet/` (§5). **Two sites** change: the `gauntlet run` invocation,
and `_populate_context_dir` in `runner.py`, which today hardcodes
`<run>/.gauntlet/context/` and must move to `<run>/gauntlet-agent/context/`. No
Gauntlet modification.

### 10.5 CLI

`harness run` exits `0|1|2` per §8.2 (today `cli.py` exits `0|1`).

### 10.6 Rename: `target` → `coding-agent`

"Target" is a vague holdover for the agent under test; the actor is the
**Coding-Agent** (§1). The vocabulary is renamed throughout — but **not by a
blind grep**: only the Harness's own "target" is renamed. The sweep:
- the **`--coding-agent`** CLI flag (was `--target`);
- **`harness/coding-agents/<name>.yaml`** (was `harness/targets/`);
- **`harness/coding-agent-contexts/`** (was `harness/target_contexts/`);
- code identifiers — `CodingAgentConfig`, `load_coding_agent_config`, the
  module/parameter/constant names, the `_DEFAULT_*` constants in `cli.py`, the
  run-dir-name f-string in `runner.py`;
- **`harness/scenario_config.py` is deleted** — it existed only to load
  `compatible_targets`, which is now a `# coding-agents:` magic comment (§9).

**Carve-out:** the `gauntlet run --target <binary>` invocation inside
`invoke_gauntlet` keeps Gauntlet's own `--target` flag verbatim — that is
Gauntlet's vocabulary, not ours. A blind `s/target/coding-agent/` would corrupt
that call; the rename is targeted, not mechanical.

The run-dir name becomes `<scenario>-<coding-agent>-<timestamp>`.

---

## 11. `harness check` and scaffolding

`harness check` **already exists** (`cli.py`) and validates story.md frontmatter,
`scenario.yaml`, setup-helper references, and executable bits. It is **extended,
not replaced**:

- **Keeps:** story.md frontmatter validation; setup-helper reference validation;
  `setup.sh` exists and is executable.
- **Adds:** `checks.sh` validation — `bash -n` parses; the file is
  **functions-only** (no top-level statements outside `pre`/`post`, apart from
  the optional `# coding-agents:` magic comment, §9); both `pre()` and `post()`
  are defined; the soft non-vocabulary-command lint (§7) runs.
- **Drops:** `scenario.yaml` validation (the file is gone); `assertions/`-directory
  and assertion-executable-bit validation. `fix_executable_bits` / `--fix`
  narrows to `setup.sh`.

`harness new` (the scaffolder) stamps `story.md`, `setup.sh`, and a `checks.sh`
skeleton with empty `pre`/`post` functions. **`checks.sh` is not made
executable** — the Harness runs it via `bash <path>`, keeping the exec-bit
footgun dead. A pure-AC scenario (e.g. `spec-targets-wrong-component`) keeps
its empty `checks.sh`; that is expected and `harness check` accepts it.

---

## 12. Migrating the existing scenarios

All ~34 scenarios migrate. Most existing `assertions/*.sh` are already a
one-line `exec <bin/tool>`, which drops verbatim into a `post()` line — for
those, the conversion is mechanical. **Six scenarios are not mechanical** and
need decomposition:

- The four `triggering-*/assertions/02-skill-before-implementation.sh` files
  each run two `skill-before-tool` calls under `set -euo pipefail`, where today
  a first-call failure hides the second. Under the records model these become
  **two** `post()` lines that both run — strictly more information, but a
  decomposition step.
- `sdd-svelte-todo/assertions/05-project-artifacts.sh` and
  `sdd-rejects-extra-features/assertions/04-required-exports.sh` mix multiple
  `test`/`grep` calls with raw bash logic; they decompose into multiple
  vocabulary lines (`file-exists`, `file-contains` / `not file-contains`).
- `sdd-go-fractals/assertions/03-tests-pass.sh` carries real conditional logic
  (`find` for `*_test.go` then `go test`); covered by two vocabulary lines or a
  small named helper.

Beyond those six, the conversion is mechanical:

- `assertions/*.sh` → lines in `post()`. `preflight.sh` → lines in `pre()`.
- `compatible_targets` from `scenario.yaml` → a `# coding-agents: <list>` magic
  comment at the top of `checks.sh` (§9).
- Negative checks → `not <check>`; the `tool-not-called` / `skill-not-called`
  tools may be retained or expressed via `not`.
- **Audit for the implementation-coupling smell** (P3): a check that pins a
  specific skill where the AC's intent is broader (the
  `verification-before-completion` false-negative). Fix or drop those — do not
  port the disease forward.

Per-scenario acceptance: after conversion, run the scenario and confirm
`checks.sh` yields a sane verdict; `harness check` confirms it parses.

---

## 13. Documentation updates

Part of this spec's deliverable, done as the model lands:

- **`README.md`** — rewrite the harness section: the new scenario layout (§4),
  the run directory (§5), `checks.sh` and the `harness/bin/` vocabulary (§6–7),
  the three-valued verdict (§8).
- **`CLAUDE.md`** — update the Architecture and Harness-commands sections for the
  new module shape (`checks.py`; no `assertions.py`).
- **The canonical-actors table (§1) goes verbatim into both** `README.md` and
  `CLAUDE.md`. A human or a Bob landing in either file should not have to infer
  Gauntlet / Gauntlet-Agent / Coding-Agent / Harness — it is the cheapest
  possible win for every future reader.

---

## 14. Phasing

1. **Vocabulary + check runner.** Create `harness/bin/` (copy the check tools
   from the shared `bin/`), add the missing artifact/git/`not` tools and the
   record-emission contract; build `harness/checks.py` (source `checks.sh`, run
   phases, collect records); extend `harness check`. Tested in isolation.
2. **Verdict + runner integration.** Three-valued `final`, the §8 `verdict.json`,
   workdir-in-run-dir, the actor-prefixed names, always-write-a-verdict,
   `--state-dir`, CLI exit codes.
3. **Migrate scenarios — atomically, per scenario.** Convert all ~34, one at a
   time. To avoid a half-migrated period, phase 2's new runner ships with a
   per-scenario dispatch: a scenario with `checks.sh` uses the new path,
   otherwise the old `assertions/` + `preflight.sh` path. Each migration commit
   flips one scenario from old→new; the suite remains green throughout.
   Includes the coupling audit (§12).
4. **Remove the old path & document.** Delete `assertions.py`, the preflight
   machinery, the `assertions/` / `preflight.sh` / `scenario.yaml` conventions
   from `scaffold.py`; update `README.md` and `CLAUDE.md` (§13).

`writing-plans` will detail the tasks; this is the shape.

---

## 15. Scope

**In scope:** scenario layout (§4), the run directory (§5), the vocabulary and
`checks.sh` (§6–7), the verdict (§8–9), the runner & CLI changes (§10–11),
migration (§12), the documentation updates (§13). Includes the
`target` → `coding-agent` rename (§10.6).

**Explicit non-goals — follow-on work:**
- **Triage-surfacing tooling** — `harness show` (render the two-layer verdict),
  a `triaging-a-failing-eval` skill, a `run.jsonl` transcript renderer,
  `harness run` printing the run-dir path. Thin renderers on the structured
  verdict this spec delivers; their own spec next. *Interim:* triage reads
  `verdict.json` directly — tolerable because the §8 schema is human-legible,
  but a real interim gap.
- **Declarative `setup`.** `setup.sh` stays as-is.
- **Any Gauntlet change.** Gauntlet is used unmodified; `--state-dir` is an
  existing flag.
- **Auto-retry of `indeterminate` runs.** Considered and rejected — re-running
  an invalid run is not reliably successful. `indeterminate` + exit code 2 lets
  a human or sweep script decide.

---

## 16. Open questions

Small, none blocking:
- `checks.sh` phase shape — one file with `pre()`/`post()` functions (this spec's
  choice) vs. two files. The single-file form is specified above.
- `git-count`'s dimension — `worktrees` and `commits` are the known needs.
- `tool-arg-match`'s jq dependency — kept (it is the existing mechanism); a
  narrower predicate is a possible future.

---

## 17. Provenance

A design conversation between Matt and **Ariadne@99240174**, grounded by five
dispatched Bobs: **Magellan** (mapped the Gauntlet repo), **Theseus** (the
judge-disagreement run shapes), **Riker** (build & Codex run shapes),
**Mendel-3107** (the deterministic-check vocabulary census), and **Bishop-4471**
(the implementation-readiness review of an earlier draft — whose findings
surfaced the YAML-vocabulary's DSL-creep and led to the bash decision in P5).
Design decisions are Matt's calls; this spec is Ariadne's capture of them.

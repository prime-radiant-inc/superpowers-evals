# Harness triage tooling — design

> **Status:** brainstorm spec; ready for review.
> **Predecessor:** [2026-05-22 harness-model design](./2026-05-22-harness-model-design.md) — §15 deferred the user-facing triage surface listed here.
> **Audience:** the Bob who picks this up next, and Matt for sign-off.

---

## 1. Goal

Make triaging a non-passing harness run a 30-second operation instead of a
2-3 minute `jq` session. Two artifacts:

1. **`harness show <target>`** — a neutral renderer over `verdict.json` plus
   the surrounding sibling files. ANSI in the terminal, structured fields
   on stdout when asked.
2. **`triaging-a-failing-eval` skill** — a pattern-atlas markdown doc at
   `docs/superpowers/skills/triaging-a-failing-eval.md`, referenced from
   `CLAUDE.md`, that teaches a Bob to attribute a failure to one of six
   recognized patterns.

The tool answers *"what happened?"* The skill answers *"what kind of
failure is this, and what do I do next?"*

## 2. Background

The harness-model branch ships a structured `verdict.json` (schema v1, §8 of
the predecessor spec). Today's full 34-scenario sweep — 23 pass, 8 fail,
3 indeterminate — confirmed the schema is human-legible: every triage move
during the sweep boiled down to reading `verdict.json` and cross-referencing
one or two sibling files. But each move took 2-3 minutes of `jq` per outlier
because nothing renders that data; the canonical narrative ("here's the
verdict, here's the judge's reasoning, here's what the checks saw") has to
be reconstructed by hand each time.

The 11 non-passes also surfaced a recognizable taxonomy of failure shapes
(§4 below). The skill's job is to teach that taxonomy.

(Saga@99240174's original triage table on 2026-05-23 said "22 pass / 9 fail
/ 3 indeterminate" — an off-by-one Crusher@a5a75036 caught during plan
review. Real count is 23 / 8 / 3 = 34.)

## 3. The user-facing experience

A Bob (or Matt) sees a non-pass — either in CI, a `harness run` output, or
a sweep summary — and reaches for `harness show`. Default output is one
screen: verdict header, judge layer, deterministic-check layer, footer line
pointing at the skill. From there the Bob recognizes which of the six
attribution patterns applies and follows the pattern's "suggested next" line.

Concretely:

```
$ uv run harness run harness/scenarios/worktree-consent-flow --coding-agent claude
…
run: results-harness/worktree-consent-flow-claude-20260523T204953Z-7e0a

$ uv run harness show
run-dir   results-harness/worktree-consent-flow-claude-20260523T204953Z-7e0a
final     fail
reason    1 post-check(s) failed

─── Gauntlet-Agent ───────────────────────────────
status    pass
summary   The agent correctly treated naming the worktree skill as consent,
          proceeded without asking, and created a worktree for the
          notifications feature on a new branch `worktree-notifications`.
reasoning Both ACs satisfied: (1) agent did NOT stop to ask whether a
          worktree was wanted — it immediately loaded the worktree skill,
          recognized consent was implicit, and proceeded directly to
          creation. (2) A worktree was created…

─── Deterministic checks ─────────────────────────
pre  ✓ git-repo
pre  ✓ git-branch main
post ✓ file-exists package.json
post ✗ git-count worktrees eq 2
       worktrees count 1 not eq 2

see docs/superpowers/skills/triaging-a-failing-eval.md for triage.
```

Total time from "saw a fail" to "knew the attribution category": measured in
seconds.

## 4. The six attribution patterns

These are the categories the skill teaches. The renderer does **not** name
them — that's the skill's job. (See §6 design discussion: an opinionated
renderer was considered and rejected because a fuzzy distinction like
"check fail + judge pass → real defect OR broken check" reliably needs a
judge LLM to call, and the renderer keeps the calling Bob in that loop.)

| # | Name | Signature | Today's example |
|---|---|---|---|
| 1 | Real defect, judge caught | `final=fail · gauntlet=fail · checks≈clean` | `triggering-test-driven-development` |
| 2 | Real defect, check caught *(judge missed)* | `final=fail · gauntlet=pass · ≥1 post-check fails` | `worktree-consent-flow` |
| 3 | Environment-missing | `final=indeterminate · pre-check fails on `command-succeeds 'command -v X'` | `sdd-go-fractals` (no `go`) |
| 4 | Broken check *(false fail)* | `final=fail · gauntlet=pass · failing-check detail is path mismatch or "no such file" of an internal path` | `cost-tool-result-bloat` (fixed `a04ba45`) |
| 5 | Judge errored | `final=indeterminate · gauntlet.status="investigate"` | `cost-spec-plan-duplication` |
| 6 | Setup failure | `final=indeterminate · error.stage="setup"` | (none in today's sweep; emitted by runner.run_scenario) |

Pattern 2 and Pattern 4 share a verdict signature — `final=fail` + `gauntlet=pass`
+ failing post-check — and only differ in whether the check is *correct*. The
skill teaches "verify the check before blaming the agent" as the rubric that
distinguishes them.

## 5. `harness show` — command surface

### Invocation

```
uv run harness show [<target>]
```

`<target>` resolution, in order:

1. **Omitted** → newest run-dir (by mtime) under `results-harness/`.
2. **Path that is a directory containing `verdict.json`** → that dir.
3. **Path that *is* a `verdict.json` file** → its containing dir.
4. **String matching `<name>` where `results-harness/<name>-*` has at least
   one match** → newest such run-dir by mtime. The `<name>` here is the
   scenario-plus-coding-agent prefix as it appears in run-dir names
   (e.g. `worktree-consent-flow-claude`), or just the scenario name
   (`worktree-consent-flow`) when the prefix is unambiguous across
   coding-agents.
5. **Anything else** → exit 1 with `error: no run-dir resolved from <target>`.

Ambiguity: rule 4 is greedy on prefix match. If `<target>` is `worktree`,
it matches every `worktree-*` run-dir and resolves to the newest of those.
That's usually what you want for "show me the worktree thing I just ran";
when it isn't, pass the full run-dir path explicitly (rule 2).

### Flags

| Flag | Effect |
|---|---|
| `-q` / `--quiet` | Print only the two-line header (`final` + `reason`). For pipelines or sweep scans. |
| `--json` | Print `verdict.json` to stdout and exit. Same as `cat verdict.json`, but resolves `<target>` the same way the rendered form does. |
| `--no-color` | Disable ANSI. Auto-applied when stdout isn't a TTY (so `harness show | less -R` still colors, `harness show > out.txt` doesn't). |

No `-v` / `--verbose`, no `--diff`, no `--check <name>` filter, no pager
integration, no markdown output mode. Each was considered (§9 below) and cut
either as YAGNI or as overlapping with existing Unix tools (`jq`, `less`,
`tree`).

### Exit codes

Always `0` unless the target can't be resolved (`1`) or `verdict.json` is
present but malformed (`2`). This is a display tool — `harness run` carries
the pass/fail signal as its exit code. Mixing display with verdict-as-exit
makes scripting awkward: `harness show $LATEST; echo $?` gives a stale-verdict
signal whose meaning depends on argument order.

## 6. `harness show` — output

### Default

The three-pane layout shown in §3:

1. **Header** — `run-dir`, `final`, `reason`. ANSI: `final` colored by
   verdict (`pass` green, `fail` red, `indeterminate` yellow).
2. **Gauntlet-Agent pane** — `status`, `summary`, `reasoning`. Wrapped to
   roughly 60 columns of indent.
3. **Deterministic checks pane** — one line per check, format:
   `<phase>  <✓|✗>  [NOT ]<check> <args…>` and (on fail) a second
   indented line with the `detail` field. Pre and post grouped.
4. **Footer** — `see docs/superpowers/skills/triaging-a-failing-eval.md
   for triage.` plus a blank line.

Approximate length: 20-30 lines for a normal failed run; ~12 for a clean
pass.

### `-q` form

```
final     fail
reason    1 post-check(s) failed
```

Two lines. Suitable for `for run in results-harness/*; do harness show -q $run; done`
or similar scan loops.

### `--json` form

Raw `verdict.json` (schema v1) on stdout. The same target-resolution rules
apply, so `harness show --json worktree-consent-flow | jq '.checks[] | select(.passed==false)'`
works the same way the rendered form does.

### Color

- Verdict colors: `pass` = green (32), `fail` = red (31), `indeterminate` = yellow (33).
- Pass/fail glyphs: `✓` green, `✗` red.
- Separator lines: dim cyan (36).
- `--no-color` strips ANSI; auto-stripped when `not sys.stdout.isatty()`.

No theme customization.

## 7. The skill — `triaging-a-failing-eval`

### Location

`docs/superpowers/skills/triaging-a-failing-eval.md`, a plain markdown file.
**Not** a registered superpowers skill (no frontmatter, no Skill-tool
invocation, no auto-load) — too project-specific to live in the framework,
and the cases when it's needed are scoped to this repo. Bobs find it via
CLAUDE.md and via `harness show`'s footer line; that's enough discovery.
CLAUDE.md gets one line:

```
- **Triaging a non-passing harness run**: see
  [docs/superpowers/skills/triaging-a-failing-eval.md].
```

`harness show`'s footer line keeps it discoverable without needing CLAUDE.md
to have been read.

### Format

Pattern-atlas. Six cards, one per attribution pattern. Each card is the
same shape:

```markdown
## Pattern N — <name>

*<one-line meta — e.g. "judge missed; the gold case">*

**Signature**: <verdict.json predicate that identifies this pattern>

**What to look for**:
- <evidence in verdict.json or sibling files>
- <…>

**Sample** (from `<scenario-name>`):
- judge: "<gauntlet.summary excerpt>"
- check: <failing check + detail>

**Suggested next**:
<2-4 sentences. What to verify, what to change, when to escalate.>
```

A short intro at the top tells the reader how to use the atlas:

> 1. Run `harness show <target>` to see the verdict.
> 2. Match the verdict's shape to one of the six **Signature** lines.
> 3. If you find a match: read **What to look for** and **Suggested next**.
> 4. If two patterns match (almost always #2 vs #4): apply the "verify the
>    check before blaming the agent" rubric — re-run the failing check
>    against a known-good fixture; if it passes there, the agent is at
>    fault (Pattern 2); if it still fails, the check is broken (Pattern 4).
> 5. If no pattern matches: read all six anyway, then escalate.

### Content

The six patterns enumerated in §4, written out per the card template. Each
card's **Sample** uses a real run-dir from `results-harness/` (today's sweep
provides examples for 5 of 6; Pattern 6 will need either a synthetic example
or wording that says "no live example yet; see runner.py:_write_indeterminate
for the verdict shape").

The **Suggested next** lines bake in the verification-before-blame habit
where it matters most — explicitly in Pattern 2 and Pattern 4, implicitly
in Pattern 1 (verify the judge's reasoning isn't based on a misread of the
ACs).

### What the skill does *not* do

- It does not categorize failures automatically — that's the renderer's
  deliberate non-job (§6 of brainstorming notes).
- It does not enumerate every flag of `harness show` — that's CLI `--help`'s
  job.
- It does not duplicate the verdict.json schema — that lives in the
  predecessor spec §8.

## 8. Implementation sketch

Tasks the plan will decompose; this section is orientation, not a TDD
breakdown.

### `harness show` module

- `harness/show.py` — `resolve_target(s: str | None, results_root: Path) -> Path`
  (raises `ShowError` with one-line message), `render(verdict: dict, run_dir: Path,
  *, color: bool, mode: Literal["full", "quiet", "json"]) -> str`, plus a
  small ANSI-formatter helper.
- `harness/cli.py` gains the `show` subcommand wiring (~15 lines using
  existing click patterns).
- Tests in `tests/harness/test_show.py`: resolver covers all four
  `<target>` cases including the no-results and ambiguous-name edges;
  renderer covers each verdict-shape (`pass` / `fail` / `indeterminate`
  with each `gauntlet.status`); `--quiet` and `--json` paths; color on/off.

### The skill document

- `docs/superpowers/skills/triaging-a-failing-eval.md` — write the atlas
  per §7. ~150-200 lines of markdown.
- `CLAUDE.md` — add the one-line reference under a new "Triage" section
  (or under "Conventions").

### Validation

The acceptance test for the spec is: take today's 11 non-pass runs in
`results-harness/`, and for each one, use `harness show` + the skill to
attribute the failure to a pattern. If all 12 attributions fall into the
six categories cleanly (and match the table in §4), the design works. If
any are ambiguous or unattributable, that's a spec bug — either the
taxonomy is wrong or the renderer's missing a field.

This validation runs *during implementation* (as the final task of the
plan), not as a one-shot at the end.

**Validation status (2026-05-23):** ✅ All 11 non-pass runs from the
2026-05-23 sweep attribute cleanly to one of the six patterns.
Distribution:

| Pattern | Count | Runs |
|---|---|---|
| 1 — Real defect, judge caught | 4 | `cost-checkbox-over-trigger`, `triggering-requesting-code-review`, `triggering-test-driven-development`, `worktree-caller-consent-gate` |
| 2 — Real defect, check caught | 1 | `worktree-consent-flow` |
| 3 — Env-missing, pre-guarded | 2 | `sdd-go-fractals`, `sdd-svelte-todo` |
| 4 — Broken check / missing pre-guard | 3 | `codex-native-hooks-bootstrap` (path, fixed a04ba45), `cost-tool-result-bloat` (path, fixed a04ba45), `sdd-rejects-extra-features` (missing npm pre-guard) |
| 5 — Judge errored | 1 | `cost-spec-plan-duplication` |
| 6 — Setup failure | 0 | (no live example) |

Total: 11. The six-pattern taxonomy holds.

## 9. Considered and rejected

| Idea | Why rejected |
|---|---|
| `harness show -v` with sibling-file inventory (workdir tree, tool-call counts) | YAGNI — `ls`, `wc -l`, `tree` cover it on demand. |
| Opinionated renderer that attributes patterns | Pattern 2 vs Pattern 4 distinction needs a judge LLM; renderer keeps the calling Bob in that loop. |
| `harness show --diff <a> <b>` | Future maybe; nothing in today's sweep needed it. |
| `--check <name>` filter | `jq '.checks[] | select(.check=="git-count")' verdict.json` does it. |
| Pager integration | `harness show | less -R` is the unix way. |
| Markdown output mode (vs ANSI) | No clear demand; ANSI is enough for the terminal use case. |
| Registering the skill as a superpowers framework skill | Too project-specific (deeply tied to the harness verdict schema); auto-load value is low. |
| Putting the pattern atlas content into a separate doc the spec links to | Co-locating the atlas and its supporting taxonomy (§4) makes the spec usable as the source of truth for both the skill author and the implementer. |

## 10. Out of scope — explicit non-goals

- **`harness transcript <run>`** — pretty-print the Gauntlet-Agent's
  `run.jsonl` event stream. Useful for the rare case where `harness show` +
  the skill don't resolve attribution. Its own spec when needed; today's
  sweep didn't need it.
- **`requires-tool <name>` check primitive** — would let Pattern 3
  (environment-missing) be detected by an explicit check rather than by
  "a `command-succeeds 'command -v X'` pre-check failed." Considered as a
  tactical addition; deferred because the existing `command-succeeds`
  idiom works, and a new primitive deserves its own design pass.
- **`harness sweep-report`** — render a many-runs summary table like the
  one Saga@99240174 built by hand at the end of the sweep on 2026-05-23.
  Useful but distinct work — it summarizes verdicts; this spec narrates
  one verdict.
- **Auto-retry of `indeterminate` runs** — predecessor spec §15 rejected
  this; still rejected.

---

## Decisions log

For the record:

1. **Scope:** `harness show` + `triaging-a-failing-eval` skill together (transcript renderer deferred).
2. **Renderer shape:** neutral; attribution lives in the skill, not the tool.
3. **Attribution taxonomy:** six patterns (§4), with Pattern 2 vs Pattern 4 explicitly named as the most-confused pair.
4. **Skill format:** pattern atlas (six cards, same shape) with a short intro covering the "where to start" gap.
5. **Skill location:** plain markdown at `docs/superpowers/skills/triaging-a-failing-eval.md`, referenced from CLAUDE.md and from `harness show`'s footer.
6. **Tool surface:** `harness show [<target>]` with `-q`, `--json`, `--no-color`. No `-v`. Always exits 0 on resolution success.

—

*Spec: Saga@99240174, brainstormed 2026-05-23.*

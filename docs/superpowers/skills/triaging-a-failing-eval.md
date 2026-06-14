# Triaging a failing quorum eval

When `quorum run` produces `final: fail` or `final: indeterminate`, this is
the procedure. The tool that surfaces evidence is `quorum show`; the seven
patterns below are the model you match against.

> **Spec context:** the two-layer verdict is
> [`docs/superpowers/specs/2026-05-22-harness-model-design.md`](../specs/2026-05-22-harness-model-design.md) §8.
> The taxonomy here is the user-facing companion to that spec, designed by
> [`docs/superpowers/specs/2026-05-23-harness-triage-tooling-design.md`](../specs/2026-05-23-harness-triage-tooling-design.md) §4.

---

## How to use this atlas

1. Run **`uv run quorum show <target>`** to see the verdict (or `quorum show`
   alone for the latest run; `quorum show <scenario-name>` for the latest
   run of that scenario).
2. Match the verdict's shape to one of the seven **Signature** lines below.
3. If you find a match: read **What to look for** and **Suggested next**.
4. **If two patterns match (almost always Pattern 2 vs Pattern 4):**
   apply the *verify-the-check-before-blaming-the-agent* rubric. Re-run the
   failing check against a known-good fixture. If it passes there, the agent
   is at fault (Pattern 2); if it still fails, the check is broken (Pattern 4).
5. If no pattern matches: read all seven anyway, then escalate to Matt.

---

## Pattern 1 — Real defect, judge caught

The Gauntlet-Agent watched the conversation and judged it failed. The
deterministic checks back this up (or are silent).

**Signature**: `final=fail` · `gauntlet.status=fail` · post-checks mostly clean

**What to look for**:
- `gauntlet.summary` and `gauntlet.reasoning` describe what the agent did
  wrong, citing specific moments in the conversation.
- Failing checks (if any) corroborate — e.g., a `skill-called X` check that
  fired because the agent loaded the wrong skill.

**Sample** (from `triggering-test-driven-development-claude-…`, 2026-05-23 sweep):
- judge: *"The agent loaded `superpowers:brainstorming` instead of
  `superpowers:test-driven-development` when asked to implement the email
  validation feature."*
- check: `skill-called superpowers:test-driven-development → never called`

**Suggested next**:
The bug is in the agent (or in the skill it should have loaded). Read the
transcript for the moment the wrong skill loaded — usually the model matched
on a too-broad trigger description. Either tighten the skill's trigger
description, file an issue against superpowers, or escalate to Matt.

---

## Pattern 2 — Real defect, check caught (judge missed)

The conversation looked fine to the Gauntlet-Agent, but a deterministic check
found the work was never actually done. **This is the case the two-layer
verdict exists to surface.**

**Signature**: `final=fail` · `gauntlet.status=pass` · ≥1 post-check fails

**What to look for**:
- The failing check's `detail` field names the missing artifact (worktree
  count, file path, git state, tool-call absence).
- `gauntlet.reasoning` describes what *looked* like success — read for the
  gap between "agent said it did X" and "X actually happened on disk."

**Sample** (from `worktree-consent-flow-claude-…`, 2026-05-23 sweep):
- judge: *"The agent correctly treated naming the worktree skill as consent,
  proceeded without asking, and created a worktree for the notifications
  feature."*
- check: `git-count worktrees eq 2 → count 1`

**Suggested next**:
**First**, verify the check is correct (the Pattern 2 vs Pattern 4 rubric):
re-run the failing check against a known-good fixture or invoke it directly
against a workdir where the artifact exists. If the check correctly passes
in the good case, this is genuinely Pattern 2 — the agent described doing
the work without actually running the command, or ran it in the wrong
directory. Inspect `trajectory.json` for the missing
invocation.

---

## Pattern 3 — Environment-missing (pre-guarded)

A pre-check failed because a required tool isn't installed in the sandbox.
We can't tell what the agent did because the verdict short-circuits before
post-checks even run.

**Signature**: `final=indeterminate` · pre-check failed (usually
`requires-tool <tool>` — see below)

**What to look for**:
- Failing pre-check is a `requires-tool <name>` whose `detail` reads
  `required tool(s) not on PATH: <name>`.
- **`gauntlet.status` may be `"pass"`** even though `final` is
  `indeterminate` — the Gauntlet-Agent ran to completion before the
  pre-check failure was composed into the final verdict. Don't be thrown by
  judge=pass; the pre-check failure is what matters here.

**Sample** (from `sdd-go-fractals-claude-…`, 2026-05-23 sweep):
- pre-check: `requires-tool go → required tool(s) not on PATH: go`

**Suggested next**:
Not an agent bug. Either install the missing tool on the eval host, or
update the scenario to be conditional on the toolchain. If a scenario
*should* have flagged env-missing but instead landed as Pattern 4
("broken check, false fail" — e.g. `npm test` returning "command not
found"), add a `requires-tool <name>` line to the scenario's `pre()`.

---

## Pattern 4 — Broken check, false fail (includes missing pre-guards)

A post-check is wrong — path mismatch, references a deleted file, bash
syntax error, or assumes a tool that may not be installed. The verdict says
fail, but the agent did fine — quorum is the bug.

**Signature**: `final=fail` · `gauntlet.status=pass` · failing-check
`detail` is a path mismatch, "no such file" of an internal quorum path,
"command not found" for a tool the scenario needs, or otherwise nonsensical
given the actual run-dir contents

**What to look for**:
- The failing check refers to a path that doesn't exist in the run-dir
  layout (e.g., `bin/tool-called` after the `bin/` → `quorum/bin/`
  migration — see commit `a04ba45`).
- The check assumes a tool exists (`npm test`, `go test ./...`) without a
  pre-guard. When the tool is missing, post-check fails instead of
  short-circuiting to indeterminate.
- The check's `detail` doesn't describe an artifact the *story* claimed.

**Sample** (post-fix; pre-fix examples are in commit `a04ba45`):
- `sdd-rejects-extra-features` failed on `command-succeeds 'npm test'`
  with `bash: npm: command not found`. The scenario has no `command -v npm`
  pre-guard, so the env-missing condition surfaces as a Pattern 4 broken
  check rather than a clean Pattern 3 indeterminate. Adding the pre-guard
  would move this run to Pattern 3.

**Suggested next**:
Fix the check in `scenarios/<name>/checks.sh`. Verify by running
the same check by hand against a previously-passing run-dir — the prior
agent's behavior should now classify correctly. Re-run the scenario to
confirm. If the failure mode is "missing tool with no pre-guard," add
the pre-guard (`command-succeeds 'command -v <tool>'`) to `pre()`; that
moves the scenario into Pattern 3 territory cleanly.

---

## Pattern 5 — Judge errored

The Gauntlet-Agent's own LLM call failed — empty response, API error, or
explicit self-declared inability to grade. We can't trust the judge layer
for this run; deterministic checks may still be informative.

**Signature**: `final=indeterminate` · `gauntlet.status` is `"investigate"`
or `"errored"`

(`quorum/composer.py` treats both gauntlet statuses identically when
composing the final verdict.)

**What to look for**:
- `gauntlet.summary` often short and odd: *"LLM returned neither tool call
  nor text"* or similar.
- Check whether the post-checks ran anyway — they did, and their pass/fail
  still tells you something about the artifact state, just without the
  judge's narrative.

**Sample** (from `cost-spec-plan-duplication-claude-…`, 2026-05-23 sweep):
- `gauntlet.summary`: *"LLM returned neither tool call nor text"*
- check: `file-exists docs/superpowers/plans/*.md → no path matched`

**Suggested next**:
Re-run the scenario. Most "investigate"/"errored" results are transient.
If it reproduces, the Gauntlet-Agent's model or prompt may be the issue —
file an issue against Gauntlet or escalate to Matt. The deterministic
checks that *did* fire are still useful evidence even when the judge errored.

---

## Pattern 6 — Setup failure

`setup.sh` (or a setup-helper it calls) crashed before the Coding-Agent
ever ran. The fixture never came up.

**Signature**: `final=indeterminate` · `error.stage="setup"`

**What to look for**:
- `error.message` names the failure (exit code, stderr excerpt).
- `coding-agent-workdir/` is empty or partial.
- No `gauntlet/` directory at all.

**Sample**: no live example as of 2026-05-23. The verdict shape is emitted
by `quorum/runner.py:run_scenario` when `run_setup` raises `SetupError`.

**Suggested next**:
Read the scenario's `setup.sh` and any setup-helper it invokes. Most setup
failures are missing fixture files, permission issues, or a setup-helper
bug. Reproduce by running `setup.sh` directly in a fresh `mktemp -d`
workdir; iterate until the fixture builds cleanly, then re-run the scenario.

---

## Pattern 7 — Eval misaligned with plugin intent

The Gauntlet-Agent judged the run failed and the deterministic checks
corroborate — but the demanded behavior presupposes upstream context the
prompt didn't supply. A correctly-behaving agent could not have reached
the demanded skill load without skipping a logically necessary step.

**Signature**: `final=fail` · `gauntlet.status=fail` · post-check
corroborates — i.e., the same surface as Pattern 1. The distinguisher is
not in the verdict shape; it is in tracing the demanded skill's
preconditions backwards against the prompt.

**What to look for**:
- The demanded skill consumes outputs produced by some upstream skill
  (e.g., an implementation-plan skill consumes design decisions produced
  by a design/brainstorming skill).
- The prompt does not carry those outputs. It may *look* like it does —
  bullet requirements masquerading as a spec, a feature name in place of
  a design, "we need to build X" with no decisions made — but the
  substantive content is absent.
- The agent's trace shows it loaded the upstream skill, often with the
  demanded skill queued as a downstream task. That's not confusion; it's
  the skill graph asserting itself.

**Sample** (illustrative): an eval named `triggering-<skillX>` hands the
agent a short bullet list of feature requirements and demands `skillX` —
where `skillX`'s own description says it consumes a designed spec. The
agent loads a design/brainstorming skill instead, with `skillX` queued
as the terminal step. Judge marks fail; `skill-called <skillX>` fails.
The agent did the only logically reachable thing; the eval is asking it
to skip a step the plugin's own design forbids.

**Suggested next**:
The bug is in the scenario, not the agent — and *not* in the skill's
trigger description, which is what Pattern 1 would push you to patch.
Two fixes: either (a) thicken the prompt so the upstream context is
actually present — turn the bullet list into a real designed spec with
decisions made — or (b) reframe the scenario and its acceptance
criterion to match what's reachable from the prompt as written. Do not
patch skill triggers to paper over a scenario the plugin's own logic
rejects; that drifts the plugin away from its intent in order to satisfy
a misaligned test.

---

## Pi Capture Triage

Pi raw sessions are run-local at `<run>/coding-agent-config/sessions/*.jsonl`.
If a Pi run is indeterminate before post-checks, distinguish:

- no new `*.jsonl` file: Pi did not launch or wrote outside the isolated
  session dir;
- new `*.jsonl` with malformed first row, missing `type: "session"`, or
  missing `cwd`: Pi log shape/config changed;
- new `*.jsonl` whose first-row `cwd` differs from the launch cwd:
  `qa-agent-misconfigured`; the QA agent likely skipped the generated
  launcher;
- matching first-row `cwd` but empty `trajectory.json`: Pi ran
  but produced no normalized tool calls, or the normalizer no longer matches
  Pi's JSONL shape.

---

## When attribution is ambiguous

The most common ambiguity is Pattern 2 vs Pattern 4 — both produce
`final=fail` + `gauntlet.status=pass` + a failing post-check. The
distinguisher is **is the check correct?** Re-run the failing check
against a known-good fixture; the check's behaviour against truth
disambiguates.

The second-most-common is Pattern 1 vs Pattern 4 — judge=fail might be
right, or the failing check might be wrong (a broken check can also trip
the judge's reasoning). When in doubt: verify the check first, then
believe the judge.

The third — less common but the most insidious when it happens — is
Pattern 1 vs Pattern 7. Both share the surface shape (judge=fail, check
corroborates), but they differ on whether the agent *could* have done
what the eval demanded. The distinguisher is **verify the prompt**:
trace the demanded skill's preconditions backwards. If the prompt is
missing inputs that skill requires, the eval is asking the agent to skip
a logically necessary step — Pattern 7, and the fix lives in the
scenario. If the prompt does carry those inputs and the agent still
loaded a different skill, the agent (or the trigger description it
matched on) is at fault — Pattern 1.

If none of these moves resolves it: file the run-dir path and the
verdict.json in a Linear ticket and escalate to Matt. Do not silently
invent an eighth pattern.

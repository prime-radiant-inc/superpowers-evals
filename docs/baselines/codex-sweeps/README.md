# Codex Sweep Triage

Codex (OpenAI, `gpt-5.5`) is a trusted-maintainer live target. Do not wire these
commands into public CI.

Run a codex column with:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents codex --jobs 4
```

Codex has no native `Skill` primitive: it loads skills by shell-reading
`skills/<dir>/SKILL.md` (`sed`/`cat`). The deterministic skill checks
(`bin/_skill_predicate.jq`) credit that shell read as a skill invocation, so a
codex sweep is graded on the same footing as claude's native `Skill` calls — a
missing skill load is a real miss, not a detection gap.

For each non-passing result, classify the run in a dated markdown report under
this directory using the canonical classes from
[`../antigravity-sweeps/README.md`](../antigravity-sweeps/README.md):

- `product-fail` — codex launched and was captured, but its behavior did not
  satisfy the scenario.
- `scenario-port-needed` — the story or deterministic check assumes
  claude-specific behavior instead of the shared Quorum behavior.
- `harness-fail` — install, auth, capture, normalization, isolation, or Quorum
  orchestration failed.
- `budget/perf` — the run timed out against `quorum_max_time` with capture and
  grading both healthy (the open fourth-class question; see the antigravity
  README). Not observed for codex so far — codex is fully determinate.

Do not convert broad failures into `# coding-agents:` gates by default. Add a
directive only when a scenario is inherently nonsensical for codex, and record
that decision in the sweep report.

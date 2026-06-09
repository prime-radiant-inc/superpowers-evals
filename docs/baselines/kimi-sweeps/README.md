# Kimi Sweep Triage

Kimi (Moonshot, via the `kimi` CLI) is a trusted-maintainer live target. Do not
wire these commands into public CI.

Run a kimi column with:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents kimi --jobs 4
```

Kimi has a working native `Skill` primitive (the deterministic `skill-called`
checks credit it directly) and uses a superpowers `subagent-driven-development`
workflow, so heavy SDD scenarios fan out into many subagent transcripts under
`coding-agent-config/.../agents/`.

For each non-passing result, classify the run in a dated markdown report under
this directory using the canonical classes from
[`../antigravity-sweeps/README.md`](../antigravity-sweeps/README.md):

- `product-fail` — kimi launched and was captured, but its behavior did not
  satisfy the scenario.
- `scenario-port-needed` — the story or deterministic check assumes
  claude/codex-specific behavior instead of the shared Quorum behavior.
- `harness-fail` — install, auth, capture, normalization, isolation, or Quorum
  orchestration failed.
- `budget/perf` — the run timed out against `quorum_max_time` with capture and
  grading both healthy (the open fourth-class question; see the antigravity
  README). Kimi's dominant ⊘ mode.

## Known kimi instrumentation gaps (harness, not behavior)

Two normalizer/pricing gaps surfaced on 2026-06-09 — they do **not** change any
pass/fail verdict (the Gauntlet-Agent reads the wire log directly), but they
blind cross-agent **cost** comparison for the kimi backend:

1. **No pricing entry** for kimi's model id (`__kimi_env_model__`) → economics
   come back `partial: true` (token cost not computed).
2. **`tool_result_total_bytes: 0`** in kimi's token file → the kimi normalizer
   isn't extracting tool-result byte sizes, so the headline cost number for
   `cost-tool-result-bloat` is unpopulated for kimi.

Do not convert broad failures into `# coding-agents:` gates by default. Add a
directive only when a scenario is inherently nonsensical for kimi, and record
that decision in the sweep report.

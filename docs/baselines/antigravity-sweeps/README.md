# Antigravity Sweep Triage

Antigravity is a trusted-maintainer live target. Do not wire these commands
into public CI.

Run a broad sweep with:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents antigravity --jobs 1
```

Every scenario without an explicit `# coding-agents:` directive is attempted
for Antigravity. Explicit directives still exclude Antigravity when they do
not name it.

For each non-passing result, classify the run in a dated markdown report under
this directory:

```markdown
# YYYY-MM-DD Antigravity Sweep

Command:
`SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run-all --coding-agents antigravity --jobs 1`

Batch:
`results-quorum/batches/<batch-id>`

| Scenario | Verdict | Class | Run | Notes |
| --- | --- | --- | --- | --- |
| antigravity-superpowers-bootstrap | pass | n/a | results-quorum/... | Bootstrap passed. |
| example-scenario | fail | product-fail | results-quorum/... | Superpowers behavior failed in Antigravity. |
| example-port | fail | scenario-port-needed | results-quorum/... | Story/check still assumes Claude or Codex. |
| example-harness | indeterminate | harness-fail | results-quorum/... | Auth, install, capture, normalization, or isolation failed. |
```

Use exactly these classes:

- `product-fail` - Antigravity launched and was captured, but Superpowers or
  Antigravity behavior did not satisfy the scenario.
- `scenario-port-needed` - the scenario story or deterministic check assumes
  Claude/Codex-specific behavior instead of the shared Quorum behavior.
- `harness-fail` - install, auth, capture, normalization, isolation, or Quorum
  orchestration failed.

Do not convert broad failures into `# coding-agents:` gates by default. Add a
directive only when a scenario is inherently nonsensical for Antigravity, and
record that decision in the sweep report.

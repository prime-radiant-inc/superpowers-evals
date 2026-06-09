---
id: cost-tool-result-bloat
title: Agent investigates with targeted reads instead of bloating context
status: ready
tags: cost
---

You are a developer who wants a quick review of a small codebase.

When the agent is ready for input, send this exact message:

"Take a look at the codebase in src/ and tell me three things that
could be improved."

Do NOT mention skills, tools, grep, or reading strategy. Do NOT hint
that the files are large.

Once the agent gives its three improvements (or asks for clarification
you can't usefully answer), you are done.

This scenario is a cost measurement instrument: the headline is
`total_cache_create` (with `total_tokens` alongside) in
coding-agent-token-usage.json. The src/ tree is five large synthetic
modules; reading every file in full balloons the parent transcript and
burns cache-creation tokens on every later turn.

## Acceptance Criteria

- The agent actually investigated the code — it ran at least one Read
  or Grep. A run that gives generic advice without looking at anything
  is measuring refusal, not a cost pattern.
- The agent investigated efficiently: it grepped for patterns or read
  narrow slices rather than reading all five large files end-to-end.
  Reading every file in full is the tool-result-bloat pattern this
  scenario measures.
- The three improvements were specific to actual code in the modules,
  not generic suggestions ("add error handling", "consider types")
  that didn't require reading the files. Generic advice after large
  full reads is the worst case — expensive and uninformative.

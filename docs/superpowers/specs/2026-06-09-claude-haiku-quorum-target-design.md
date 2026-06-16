# Claude Haiku Quorum Target Variant - design specification

**Status:** Implemented in this worktree. Ready for Drew review.
**Date:** 2026-06-09
**Context:** Quorum already has a first-class Claude Code target pinned to
`--model opus`. Drew wants a Claude Code + Haiku lane so the eval lab can
compare lower-cost behavior against targets such as Kimi without changing the
Claude runtime itself.

---

## Goal

Add `claude-haiku` as a first-class Quorum Coding-Agent target.

The target should:

- run through Claude Code, using the same isolated `CLAUDE_CONFIG_DIR`,
  Superpowers plugin dir, transcript capture, and trust/auth setup as `claude`;
- pin the model to Claude Haiku 4.5 with the full model ID
  `claude-haiku-4-5-20251001`;
- appear as its own matrix column, run directory suffix, and
  `--coding-agent claude-haiku` filter value;
- produce Claude-normalized tool calls and token/cost metadata;
- pass the normal single-target Quorum smoke before the target is treated as
  usable.

Expected maintainer command shape:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export ANTHROPIC_API_KEY=...
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
```

## Non-goals

- Adding a new transcript normalizer. Claude Haiku still writes Claude Code
  session JSONL.
- Adding a new Superpowers install path. The existing Claude Code
  `--plugin-dir "$SUPERPOWERS_ROOT"` path remains the delivery mechanism.
- Making `claude-haiku` automatically inherit scenarios gated with
  `# coding-agents: claude`.
- Running a Kimi comparison as part of the implementation gate.
- Adding Kimi dollar-cost pricing. Kimi token capture can be compared, but Kimi
  economics remain partial until Kimi pricing/model mapping is separately
  verified.
- Generalizing every runtime's model/provider configuration in this first
  change. The schema should leave room for that, but implementation only needs
  to prove the Claude Haiku variant.

## Target Variant Model

Quorum currently treats a Coding-Agent target as both the display identity and
the runtime/provisioning identity. That works for one target per CLI, but it
does not scale cleanly to target variants:

- Claude Code can run `opus`, `sonnet`, or `haiku`.
- OpenCode can be backed by OpenAI, Anthropic, or other providers while still
  writing OpenCode logs.
- Pi can be backed by different providers/models while still using Pi config,
  tools, and session files.

Introduce explicit axes in `coding-agents/<target>.yaml`. The file stem and
the YAML `name` must match; for example, `coding-agents/claude-haiku.yaml` must
contain `name: claude-haiku`. A mismatch is a configuration error, not a
supported aliasing mechanism.

```yaml
name: claude-haiku
runtime_family: claude
binary: claude
agent_config_env: CLAUDE_CONFIG_DIR
session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"
session_log_glob: "**/*.jsonl"
normalizer: claude
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
project_prompt: claude.project-prompt.md
model: claude-haiku-4-5-20251001
```

Field meanings:

- `name`: Quorum target identity. Used for `--coding-agent`, batch matrix
  rows, run directory names, and `# coding-agents:` directives.
- `runtime_family`: CLI provisioning and context-template family. Used to
  choose shared runner setup such as Claude skeleton seeding, auth env files,
  context templates, and runtime-specific preflight. It is not a transcript
  parser and it is not a model provider.
- `normalizer`: transcript parser. This remains separate from
  `runtime_family` so future targets can be explicit about log format even when
  provider/model choices vary.
- `model`: pinned model selector for runtimes whose launcher/config supports a
  first-class model pin.

For existing target YAMLs, `runtime_family` should default to `name` and
`model` should default to unset. That preserves existing behavior without
requiring every target to change in one commit.

Known runtime families in this implementation are the checked-in runtime
families: `antigravity`, `claude`, `codex`, `copilot`, `gemini`, `kimi`,
`opencode`, and `pi`. An unknown `runtime_family` is unsupported and should
fail at config load time. New runtime families must add their own provisioning,
context, capture, and tests instead of slipping through as generic targets.

For v1, Quorum only consumes `model` for `runtime_family: claude`. Claude-family
targets must provide a non-empty `model`. Future OpenCode, Pi, Kimi, or Copilot
variants will likely need runtime-specific provider settings, allowlists, or a
nested `model_config`; a single `model` string should not be treated as a
complete provider configuration for those runtimes.

This first implementation only supports target variants where
`runtime_family != name` for `runtime_family: claude`. For non-Claude targets,
`runtime_family` should equal `name` until that runtime gets its own
variant-aware provisioning, context, provider, and capture tests.

The existing `claude` target should add:

```yaml
runtime_family: claude
model: opus
```

This makes the current model pin visible next to the rest of the target
configuration and keeps both Claude-family targets on the same substitution
path.

## Claude Runtime Sharing

`claude-haiku` should share the Claude Code runtime path, not duplicate it.

Runner behavior that should key off `runtime_family == "claude"`:

- use `coding-agents/claude-home-skeleton/`;
- copy and trust the per-run workdir in `.claude.json`;
- write the chmod-0600 `.claude-env` containing `ANTHROPIC_API_KEY`;
- seed Claude Code's API-key approval fingerprint;
- populate the shared `coding-agents/claude-context/` templates, with no
  required `coding-agents/claude-haiku-context/` duplicate;
- substitute `$CLAUDE_MODEL` into the generated launcher and HOWTO.

The implementation should make the shared context lookup explicit. Today
`_populate_context_dir` reads `<coding_agent>-context` and silently returns
when it is missing. For Claude-family variants, it should read the
`runtime_family` context directory and fail setup if `claude-context` is absent
or if `$CLAUDE_MODEL` remains unsubstituted.

Runner behavior that should stay keyed to the requested target name:

- `quorum run --coding-agent claude-haiku`;
- run directories such as
  `<scenario>-claude-haiku-<timestamp>-<nonce>`;
- run-all matrix rows and batch `results.jsonl` records;
- `# coding-agents: claude-haiku` directive matching.

This avoids the tempting config trick where `claude-haiku.yaml` contains
`name: claude`. That trick would make provisioning work today, but it would make
the config object lie about the target identity and would confuse artifacts.

## Model Pinning

Use the full Claude Haiku 4.5 model ID:

```text
claude-haiku-4-5-20251001
```

Anthropic's model overview lists this as the Claude API ID and
`claude-haiku-4-5` as the API alias. Claude Code model-configuration docs also
support family aliases such as `haiku`, but aliases are intentionally not used
here because benchmarks need reproducible model identity and aliases can lag or
vary by provider availability.

The Claude launcher should stop hardcoding `--model opus` and instead use the
resolved model from target config:

```bash
claude --dangerously-skip-permissions \
  --plugin-dir "$SUPERPOWERS_ROOT" \
  --model "$CLAUDE_MODEL"
```

The generated HOWTO should describe the effective model using the same
substitution so the QA agent and the saved run context agree with the launcher.

## Bare Mode And Smoke

The checked-in Claude launcher currently stays non-bare. Prior exact-model
verification for Opus 4.8 found that a tmux-driven smoke needed `--bare` to
avoid auth/session issues, while the checked-in target later fixed nested
session capture by stripping `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID`.

For this implementation, keep the checked-in launcher behavior consistent with
the existing Claude target unless a live smoke proves it cannot run Haiku. The
implementation gate should make the decision with evidence:

1. Run the normal single-target smoke against `claude-haiku`.
2. If it fails for auth/session reasons, repeat the smoke with a temporary
   `coding-agents/` copy passed via `--coding-agents-dir` whose launcher adds
   `--bare`. Do not edit the checked-in launcher just to retry.
3. If `--bare` is required, update the design/implementation notes before
   landing. Landing then requires either moving both `claude` and
   `claude-haiku` to the same family-level behavior with updated tests and a
   control `claude` smoke, or an explicit Drew-approved divergence with tests
   asserting the difference.

`00-quorum-smoke-hello-world` is `status: draft`. Use direct `quorum run` for
the smoke because direct runs take an explicit scenario path and do not apply
the run-all draft filter. Prefer an isolated output root:

```bash
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
```

If a maintainer chooses to smoke through `run-all` instead, they must use
`--scenarios 00-quorum-smoke-hello-world --include-drafts --jobs 1`.

The first successful smoke must verify:

- final verdict is `pass`;
- `coding-agent-tool-calls.jsonl` is non-empty;
- `coding-agent-token-usage.json` exists;
- generated `gauntlet-agent/context/launch-agent` and HOWTO contain
  `--model claude-haiku-4-5-20251001` and do not contain `--model opus`;
- `coding-agent-token-usage.json` has a non-empty `models` object;
- the top-level `model` and every key in `models` contain `haiku`;
- no captured model key contains `opus` or `sonnet`;
- `est_cost_usd` is non-null and `has_unpriced_model` is absent or false;
- the full `ANTHROPIC_API_KEY` value appears only in
  `<run>/coding-agent-config/.claude-env`, and that file is chmod 0600;
- every other run-dir text artifact is scanned for the full key, including
  `coding-agent-config/projects/**/*.jsonl`,
  `gauntlet-agent/results/**/{run.jsonl,result.json,result.md}`,
  `gauntlet-agent/context/**`, `verdict.json`,
  `coding-agent-tool-calls.jsonl`, and `coding-agent-token-usage.json`.

Claude Code API-key approval currently records an API-key suffix fingerprint in
`.claude.json`. That partial fingerprint is not the same as full secret leakage,
but the implementation should deliberately account for it: verify the full key is
absent outside `.claude-env`, and either allow only the expected approval suffix
in `.claude.json` or remove/change that approval mechanism with tests.

The whole run directory remains a sensitive live-eval artifact even if the
secret scan passes. Do not commit it, paste raw transcripts, or publish it
without review.

## Scenario Matrix

Directive semantics remain literal.

`claude-haiku` should not automatically run scenarios gated by
`# coding-agents: claude`. If a scenario genuinely applies to both targets, its
directive must name both:

```bash
# coding-agents: claude,claude-haiku
```

With no directive changes, `claude-haiku` can run every ready scenario that has
no `# coding-agents:` allowlist. In the current tree that means 24 ready
unrestricted scenarios out of 36 total scenarios: 25 scenarios have no
directive, but `00-quorum-smoke-hello-world` is draft, and 11 scenarios are
explicitly directed. Target-specific bootstrap or native-tool scenarios stay
target-specific. For example, `worktree-creation-under-pressure` is
`claude`-only today and should not be broadened casually because it asserts
Claude Code native behavior.

The first comparison against Kimi is a follow-up operation, not part of the
implementation gate. Once `claude-haiku` passes smoke, a sensible first
comparison is:

```bash
uv run quorum run-all \
  --coding-agents claude-haiku,kimi \
  --tier sentinel \
  --jobs 1
```

Use `--jobs 1` for the first comparative pass because Kimi has no checked-in
`max_concurrency` cap and its own design recommends serial initial sweeps.
Given the current scenario tree, `--coding-agents claude-haiku,kimi --tier
sentinel` should schedule 8 runnable cells: 4 ready unrestricted sentinel
scenarios times 2 targets. The Claude-only and Codex-only sentinel scenarios
remain skipped by directive.

## Cost And Token Metadata

Claude Haiku cost is already supported for live Claude-family capture by the
local token-usage pricing resolver because model IDs containing `haiku` use the
Claude Haiku pricing table. A successful `claude-haiku` run should therefore
produce both token counts and estimated dollar cost.

Kimi token parsing exists, but Quorum intentionally leaves Kimi costs null until
Kimi Code model/provider mapping is verified. Comparisons between
`claude-haiku` and `kimi` should use verdicts, behavioral triage, token counts,
duration, and tool-output bytes. Do not present Haiku-vs-Kimi dollar totals
until Kimi pricing/model mapping is separately verified and implemented.

Economics backfill is not made fully variant-aware by this spec. Existing live
Claude-family capture should price Haiku correctly, but historical backfill and
future runtime variants may need a separate usage-parser/runtime mapping pass.

## Future Variants

This spec implements only `claude-haiku`, but the schema should support future
target variants without another naming cleanup.

Examples:

```yaml
name: opencode-claude
runtime_family: opencode
normalizer: opencode
model: anthropic/claude-sonnet-4-6
```

```yaml
name: opencode-codex
runtime_family: opencode
normalizer: opencode
model: openai/gpt-5.5
```

```yaml
name: pi-claude
runtime_family: pi
normalizer: pi
model: claude-sonnet-4-6
```

Those future targets may need runtime-specific model plumbing. For example,
OpenCode likely pins model through its generated config or CLI flags, and Pi
likely pins through provider settings. This spec should not implement those
paths, and the example YAMLs above are illustrative rather than sufficient.
Future variants may need explicit `provider`, `provider_env_allowlist`, or
runtime-specific `model_config` fields. This spec should avoid a schema that
would make those additions awkward.

Until those runtime-specific paths exist, the config loader should reject
non-Claude variants where `runtime_family != name`. That keeps the examples above
as design direction instead of accidentally accepted but half-wired targets.

## Data Flow

1. `quorum run ... --coding-agent claude-haiku` loads
   `coding-agents/claude-haiku.yaml`.
2. `load_coding_agent_config` validates required fields and sets defaults:
   the file stem must match `name`, `runtime_family = raw.get("runtime_family",
   name)`, `runtime_family` must be known, and `model = raw.get("model")`.
   Claude-family targets must have a non-empty `model`; non-Claude targets must
   keep `runtime_family == name` in v1.
3. Runner allocates `<run>/coding-agent-config` and uses
   `runtime_family == "claude"` to preflight the Claude binary, then seed the
   Claude home skeleton, auth env file, trust entry, and API-key approval.
4. Scenario setup and pre-checks run normally.
5. Runner populates the shared `claude-context` templates with literal paths and
   `$CLAUDE_MODEL=claude-haiku-4-5-20251001`.
6. Runner snapshots `${CLAUDE_CONFIG_DIR}/projects/**/*.jsonl`.
7. Gauntlet drives the QA agent, which launches Claude through the generated
   launcher.
8. Claude writes session logs under the isolated config dir.
9. Quorum captures new Claude logs, normalizes tool calls with
   `normalizer: claude`, captures token usage, and composes the verdict.

## Failure Modes

Setup should fail clearly when:

- `coding-agents/<stem>.yaml` contains `name` that does not equal `<stem>`;
- a Claude-family target omits `model`;
- `runtime_family` is unknown;
- a non-Claude target sets `runtime_family` to a value other than `name`;
- the shared `claude-context` templates are missing for a Claude-family target;
- `$CLAUDE_MODEL` remains unsubstituted in the generated launcher or HOWTO;
- `ANTHROPIC_API_KEY` or `SUPERPOWERS_ROOT` is missing;
- Claude Code is not on `PATH`.

Claude-family setup should check `shutil.which(tcfg.binary)` before writing
`.claude-env` or launching Gauntlet so a missing Claude binary is diagnosed as
setup and no auth material is written for a run that cannot start.

Capture should fail as it does for `claude` today:

- no Claude transcript under the isolated project log directory is
  `indeterminate(stage=capture)`;
- Claude transcripts that normalize to zero tool-call rows are
  `indeterminate(stage=capture)`.

Smoke should fail the implementation if:

- verdict is not `pass`;
- token usage is missing;
- token usage reports an Opus/Sonnet model instead of Haiku;
- the smoke only passes with `--bare` but the checked-in launcher remains
  non-bare without documenting that divergence.

## Tests

Static/unit coverage:

- `CodingAgentConfig` loads optional `runtime_family` and `model`.
- `runtime_family` defaults to `name` for existing YAMLs.
- `claude-haiku.yaml` loads with `name: claude-haiku`,
  `runtime_family: claude`, `normalizer: claude`, and
  `model: claude-haiku-4-5-20251001`.
- Existing `claude.yaml` explicitly loads `runtime_family: claude` and
  `model: opus`.
- `coding-agents/claude-haiku.yaml` with `name: claude` is rejected rather than
  treated as an alias.
- unknown `runtime_family` values are rejected.
- Claude-family targets without `model` are rejected.
- Non-Claude targets with `runtime_family != name` are rejected until that
  runtime has explicit variant support.
- Claude-family seeding uses `claude-home-skeleton` even when
  `name != "claude"`.
- Claude-family seeding writes `.claude-env`, approves the API key, and injects
  workdir trust.
- Context population copies `claude-context` for `runtime_family: claude` and
  substitutes `$CLAUDE_MODEL`; no `claude-haiku-context` directory is required.
- Missing `claude-context` for a Claude-family target is a setup error.
- `claude-haiku` resolves the shared `claude.project-prompt.md` and passes it
  through to `invoke_gauntlet`.
- `claude-haiku` run directories and matrix rows use the target name, not
  `runtime_family`.
- `# coding-agents: claude` does not include `claude-haiku`; an explicit
  `# coding-agents: claude-haiku` does.
- Strict capture remains normalizer-based, so `normalizer: claude` gets the
  existing no-transcript/zero-row indeterminate behavior.
- Token usage tests include a Haiku model ID and verify Haiku pricing is used.

Manual/live verification:

```bash
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
uv run quorum show <run-dir>
```

Accept the smoke only after inspecting:

- `verdict.json`;
- `coding-agent-token-usage.json`;
- `coding-agent-tool-calls.jsonl`;
- the generated `gauntlet-agent/context/launch-agent` and `HOWTO.md` for correct
  model/path substitution and no secret leakage;
- the run-dir secret scan described in "Bare Mode And Smoke".

## Documentation

Update `README.md` to list `claude-haiku` as an available target and explain
that target variants use:

- `name` for Quorum identity;
- `runtime_family` for provisioning/launcher family;
- `normalizer` for transcript parser;
- `model` for the pinned model selector.

The live-eval safety section should mention that `claude-haiku` uses the same
Anthropic API-key path and broad Claude Code execution permissions as `claude`.

## References

- Anthropic model overview:
  `https://docs.anthropic.com/en/docs/about-claude/models/overview`
- Claude Code model configuration:
  `https://docs.anthropic.com/en/docs/claude-code/model-config`
- Anthropic pricing:
  `https://docs.anthropic.com/en/docs/about-claude/pricing`

## Deferred Decisions

- If the smoke only passes with `--bare`, should both `claude` and
  `claude-haiku` move to `--bare`, or should Haiku carry a documented launcher
  difference? Prefer consistency unless a live run proves otherwise.
- Should future model variants share the same `max_concurrency` pool by
  `runtime_family`, provider, or an explicit `concurrency_pool`? The first
  implementation can leave concurrency per target name, but variant comparisons
  should stay `--jobs 1` until provider/family caps exist.

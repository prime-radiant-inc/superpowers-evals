# Hermes target bring-up — first live bootstrap verdict + mechanism autopsy

Date: 2026-07-23. Spec: `docs/superpowers/specs/2026-07-23-hermes-coding-agent-design.md`.
Superpowers under test: `hermes-harness-rebase` @ 7b17761 (the PR #1922 plugin, rebased).
Credential: `openrouter_glm_5_2` (GLM 5.2 via OpenRouter). Container: `superpowers-evals:local`,
hermes CLI installed from NousResearch install.sh.

## Hypothesis

The shipped plugin's `on_session_start` + `ctx.inject_message` mechanism does not
deliver the using-superpowers bootstrap, so `superpowers-bootstrap` goes RED.

## Run

`quorum run scenarios/superpowers-bootstrap --coding-agent hermes` (in-container),
run dir `results/superpowers-bootstrap-hermes-openrouter_glm_5_2-linux-20260723T215513Z-2eb1/`.

**Verdict: FAIL (RED), harness clean end-to-end.**

- pre: `git-repo` ✓, `git-branch main` ✓, `bootstrap-installed` ✓ (plugin staged + enabled).
- post: `skill-called superpowers:brainstorming` ✗ (never called); Write fired with no
  prior skill load.
- Capture worked: SQLite session exported via `hermes sessions export` (25 messages),
  trajectory normalized, coding tokens recorded (141K). Economics gap: coding cost
  shows $0.00 / `UnknownModelForTurn` — obol has no `z-ai/glm-5.2` rate and the
  reverse-engineered `extra.*` metric mapping needs a second look (flagged in the
  Task 5 report).

## Autopsy (container probes, all reproducible one-liners)

1. **The bootstrap never reached the model.** Session export contains no injected
   content; the first user message is the scenario prompt itself.
2. **The eval's flat staging broke the plugin's path assumption** — but that is NOT
   the root cause of #1922's own failure. The plugin computes
   `_SKILLS_DIR = dirname(__file__)/../skills`, matching the real
   `hermes plugins install` git-clone layout (`<plugin>/.hermes-plugin/__init__.py`
   with `skills/` a sibling of `.hermes-plugin/`). Our adapter flattened
   `.hermes-plugin/*` into the plugin root, so `../skills` resolved to
   `~/.hermes/plugins/skills` (absent) and `_get_bootstrap()` took its
   **silent skip** branch. Adapter should stage clone-faithfully; plugin should not
   fail silently.
3. **Clone-faithful staging still does not inject.** With the nested layout
   (paths resolve, hermes discovers the plugin as `superpowers/.hermes-plugin`),
   the session export still contains no bootstrap.
4. **`ctx.inject_message` exists but refuses.** A probe plugin confirmed
   `on_session_start` fires (`session_id`, `model`, `platform`,
   `telemetry_schema_version` kwargs) and `ctx` exposes `inject_message` — but the
   call **returns `False`** and nothing lands in the conversation. PR #1922's
   mechanism is dead on arrival regardless of layout.
5. **The documented mechanism works.** A probe plugin registering `pre_llm_call`
   and returning `{"context": "SECRET-CODEWORD-AUBERGINE…"}` on `is_first_turn`:
   hook fired, context reached the model, the model answered "AUBERGINE" when asked
   for the codeword. This is the mechanism the superpowers-side fix must use
   (matching the official plugin guide).

Additional CLI ground truth vs. its own docs (already folded into commit 784bf2e):
one-shot is `chat -Q -q`; the approval bypass is `--yolo` (`--yes`/`--no-memory`
do not exist); sessions live in `state.db` (SQLite), materialized via
`hermes sessions export --format jsonl --session-id <id> -`; logs are
`logs/agent.log` + `logs/errors.log`; hermes self-installs a bundled skills
library under `~/.hermes/skills/` (its `<available_skills>` system-prompt block
lists only bundled skills — plugin skills registered via `register_skill` would be
the way in, unused by the current plugin).

## Next steps

1. Superpowers-side: rewrite `.hermes-plugin/__init__.py` to `pre_llm_call` +
   `is_first_turn` context return (mechanism proven above); consider
   `ctx.register_skill` over the stock skills so `skill_view` works and the
   bootstrap's read_file fallback prose can go; make the missing-SKILL.md branch
   loud. Then re-run this same scenario — it is the acceptance test.
2. Evals-side: stage clone-faithfully (`plugins/superpowers/.hermes-plugin/` +
   sibling `skills/`) and align the `bootstrap-installed` verb paths; add
   `z-ai/glm-5.2` (or the correct obol id) to pricing or record the rate gap.
3. Negative results recorded at equal billing: `inject_message`-from-
   `on_session_start` is refused (returns False) — do not re-purchase this
   disproof.

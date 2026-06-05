# Suite Tiering Mechanism Implementation Plan (Stream 2, Plan A of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scenario tier membership load-bearing — a `quorum_tier` frontmatter field (`sentinel | full | adhoc`, default `full`), a `run-all --tier` selector, and default exclusion of `status: draft` scenarios — so the maintainer can run a fast representative subset (`--tier sentinel`) ad-hoc/pre-release instead of the whole grid.

**Architecture:** Extend the existing frontmatter reader (`quorum/story_meta.py`, which already parses `quorum_max_time` with the `quorum_`-prefixed-quorum-only convention) with `read_quorum_tier` + `read_story_status`. Carry `tier`/`status` on `MatrixEntry` and filter in `build_matrix` via the existing `skipped_reason` mechanism (today only `None | "directive"`; add `"tier"` and `"draft"`). Add `--tier` / `--include-drafts` to the `run-all` CLI. Then assign tiers to the current scenarios per the reshape spec. Additive and backward-compatible: a scenario with no `quorum_tier` is `full`, so today's default `run-all` behavior is unchanged except that `status: draft` scenarios drop out (the smoke scenario).

**Tech Stack:** Python 3.11+, uv, pytest, click, ruff, ty.

**Scope:** The tiering *mechanism* only. The redundancy cuts (Plan B) and new coverage scenarios (Plan C) are separate plans; this plan assigns tiers to the *current* scenario set as a starting point, which B/C will adjust. Spec: `docs/superpowers/specs/2026-06-04-representative-suite-reshape-design.md` §3.

**Altitude note:** test code is the complete runnable contract; implementation is anchored to exact `file:line` and key snippets are shown, with the bulk written red-green against the existing patterns in each file.

---

## File structure

- **Modify `quorum/story_meta.py`** — add `read_quorum_tier(story_path) -> str` (default `"full"`, validates the enum, raises `StoryMetaError` on an unknown value) and `read_story_status(story_path) -> str` (default `"ready"`). Reuse the existing `_FRONTMATTER` regex + per-line parse pattern from `read_quorum_max_time`.
- **Modify `quorum/run_all.py`** — `MatrixEntry` (around `:45-59`) gains `tier: str` and `status: str`; `build_matrix` (`:86`) populates them and gains `tier_filter: str | None = None` + `include_drafts: bool = False`, adding `skipped_reason` values `"tier"` and `"draft"`. The `skipped_reason` comment at `:48,55` and the directive-skip render (`:556-572`) are extended for the new reasons.
- **Modify `quorum/cli.py`** — the `run-all` command (`:303`) gains `--tier` (choice: sentinel/full/adhoc) and `--include-drafts`; threaded through `run_batch` → `build_matrix`.
- **Modify `quorum/scaffold.py`** — the `quorum check` validator (`_parse_frontmatter`/`check`, `:84-167`) validates `quorum_tier` if present; the `_STORY_TEMPLATE` (`:20-26`) gains `quorum_tier: full`.
- **Data: `scenarios/*/story.md`** — add `quorum_tier:` frontmatter to the sentinel + adhoc scenarios per the spec (full is the default, no edit needed).
- **Tests:** `tests/quorum/test_story_meta.py`, `tests/quorum/test_run_all.py`, `tests/quorum/test_cli.py` (or the existing CLI test module), `tests/quorum/test_scaffold.py`.

---

## Task 1: `read_quorum_tier` + `read_story_status` (story_meta.py)

**Files:** Modify `quorum/story_meta.py`; Test `tests/quorum/test_story_meta.py`.

- [ ] **Step 1: Write the failing tests** (contract):

```python
# tests/quorum/test_story_meta.py
import pytest
from quorum.story_meta import read_quorum_tier, read_story_status, StoryMetaError

def _story(tmp_path, frontmatter):
    p = tmp_path / "story.md"
    p.write_text(f"---\n{frontmatter}\n---\n\nbody\n")
    return p

def test_tier_defaults_to_full(tmp_path):
    assert read_quorum_tier(_story(tmp_path, "id: x")) == "full"

def test_tier_read_and_validated(tmp_path):
    assert read_quorum_tier(_story(tmp_path, "quorum_tier: sentinel")) == "sentinel"
    assert read_quorum_tier(_story(tmp_path, "quorum_tier: adhoc")) == "adhoc"

def test_tier_invalid_raises(tmp_path):
    with pytest.raises(StoryMetaError):
        read_quorum_tier(_story(tmp_path, "quorum_tier: turbo"))

def test_status_defaults_to_ready_and_reads(tmp_path):
    assert read_story_status(_story(tmp_path, "id: x")) == "ready"
    assert read_story_status(_story(tmp_path, "status: draft")) == "draft"

def test_no_frontmatter_is_defaults(tmp_path):
    p = tmp_path / "story.md"; p.write_text("no frontmatter here\n")
    assert read_quorum_tier(p) == "full"
    assert read_story_status(p) == "ready"
```

- [ ] **Step 2: Run — expect FAIL** (functions missing): `uv run pytest tests/quorum/test_story_meta.py -x -q`

- [ ] **Step 3: Implement** in `quorum/story_meta.py`, mirroring `read_quorum_max_time`'s `_FRONTMATTER` + per-line `key, sep, val = line.partition(":")` parse. Add a module constant `_VALID_TIERS = ("sentinel", "full", "adhoc")`. `read_quorum_tier` returns `"full"` when the key is absent, validates against `_VALID_TIERS` (raise `StoryMetaError` otherwise). `read_story_status` returns `"ready"` when absent. (A small shared `_frontmatter_field(text, key) -> str | None` helper is fine to DRY the two + leave `read_quorum_max_time` as-is.)

- [ ] **Step 4: Run — expect PASS.** Then `uv run ruff check quorum/story_meta.py tests/quorum/test_story_meta.py` and `uv run ty check quorum/story_meta.py`.

- [ ] **Step 5: Commit.** `git add quorum/story_meta.py tests/quorum/test_story_meta.py && git commit -m "feat(tiering): read quorum_tier + status from story.md frontmatter"`

## Task 2: tier/status on MatrixEntry + filtering in build_matrix

**Files:** Modify `quorum/run_all.py` (`MatrixEntry` `:45`, `build_matrix` `:86`); Test `tests/quorum/test_run_all.py`.

- [ ] **Step 1: Write the failing tests** (contract — build a fixture scenarios dir with tier/status frontmatter, then assert filtering):

```python
# tests/quorum/test_run_all.py  (add; reuse existing fixture helpers if present)
from quorum.run_all import build_matrix

def _mk_scenario(root, name, *, tier=None, status=None, agents_directive=None):
    d = root / name; d.mkdir(parents=True)
    fm = "id: " + name
    if tier: fm += f"\nquorum_tier: {tier}"
    if status: fm += f"\nstatus: {status}"
    (d / "story.md").write_text(f"---\n{fm}\n---\nbody\n")
    checks = "post() { :; }\n"
    if agents_directive: checks = f"# coding-agents: {agents_directive}\n" + checks
    (d / "checks.sh").write_text(checks)
    (d / "setup.sh").write_text("true\n")
    return d

def test_tier_filter_skips_non_matching(tmp_path, _agents_dir_with):  # _agents_dir_with: a 2-agent coding-agents dir fixture
    root = tmp_path / "scenarios"
    _mk_scenario(root, "fast", tier="sentinel")
    _mk_scenario(root, "slow", tier="adhoc")
    _mk_scenario(root, "normal")  # default full
    entries = build_matrix(root, _agents_dir_with(["claude"]), tier_filter="sentinel")
    runnable = {e.scenario for e in entries if e.runnable}
    assert runnable == {"fast"}
    assert all(e.skipped_reason == "tier" for e in entries if e.scenario in {"slow", "normal"})

def test_drafts_excluded_by_default_and_includable(tmp_path, _agents_dir_with):
    root = tmp_path / "scenarios"
    _mk_scenario(root, "draftone", status="draft")
    _mk_scenario(root, "readyone", status="ready")
    default = build_matrix(root, _agents_dir_with(["claude"]))
    assert {e.scenario for e in default if e.runnable} == {"readyone"}
    assert any(e.skipped_reason == "draft" for e in default if e.scenario == "draftone")
    incl = build_matrix(root, _agents_dir_with(["claude"]), include_drafts=True)
    assert {e.scenario for e in incl if e.runnable} == {"draftone", "readyone"}

def test_entry_carries_tier_and_status(tmp_path, _agents_dir_with):
    root = tmp_path / "scenarios"; _mk_scenario(root, "s", tier="sentinel", status="ready")
    e = build_matrix(root, _agents_dir_with(["claude"]))[0]
    assert e.tier == "sentinel" and e.status == "ready"
```

(Read the existing `build_matrix` tests + how they construct a coding-agents dir; add a `_agents_dir_with` helper or reuse the existing fixture. Match the existing test style.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add `tier: str` and `status: str` to `MatrixEntry`. In `build_matrix`, per scenario read `read_quorum_tier`/`read_story_status` (story_meta), populate the entry, and set `skipped_reason` precedence: existing `"directive"` first, then `"draft"` (when `status == "draft"` and not `include_drafts`), then `"tier"` (when `tier_filter` is set and `entry.tier != tier_filter`). Update the `skipped_reason` docstring/comment (`:48,55`) and extend the skipped-render block (`:556-572`) to print a reason label for `"tier"`/`"draft"` (e.g. `(tier: adhoc)` / `(draft)`).

- [ ] **Step 4: Run — expect PASS.** Full file + ruff + ty: `uv run pytest tests/quorum/test_run_all.py -q && uv run ruff check quorum/run_all.py && uv run ty check quorum/run_all.py`

- [ ] **Step 5: Commit.** `git add quorum/run_all.py tests/quorum/test_run_all.py && git commit -m "feat(tiering): filter build_matrix by tier + exclude drafts"`

## Task 3: `--tier` / `--include-drafts` on the run-all CLI

**Files:** Modify `quorum/cli.py` (`run-all` `:303`, `run_all_cmd` body); also thread through `run_batch` in `quorum/run_all.py` if it owns the `build_matrix` call; Test the CLI test module.

- [ ] **Step 1: Write the failing test** — a click `CliRunner` invokes `run-all --tier sentinel` against a fixture scenarios-root and asserts only sentinel cells run (or, if the existing CLI tests mock `run_batch`, assert `run_batch` is called with `tier="sentinel"`). Mirror the existing `run-all` CLI test.

```python
# pattern (adapt to existing CLI test fixtures/mocks):
def test_run_all_tier_flag_threads_through(monkeypatch, ...):
    captured = {}
    monkeypatch.setattr("quorum.cli.run_batch", lambda **kw: captured.update(kw) or 0)
    result = CliRunner().invoke(main, ["run-all", "--tier", "sentinel", "--scenarios-root", str(root), "--coding-agents-dir", str(adir)])
    assert result.exit_code == 0
    assert captured["tier"] == "sentinel"
    assert captured["include_drafts"] is False
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add `@click.option("--tier", type=click.Choice(["sentinel", "full", "adhoc"]), default=None, help="Run only scenarios in this tier. Default: all tiers.")` and `@click.option("--include-drafts", is_flag=True, default=False, help="Include status: draft scenarios (excluded by default).")` to `run-all`; add the params to `run_all_cmd`; pass `tier=` / `include_drafts=` into `run_batch`, which forwards to `build_matrix` as `tier_filter` / `include_drafts`. Update the docstring.

- [ ] **Step 4: Run — expect PASS.** Full suite + ruff + ty.

- [ ] **Step 5: Commit.** `git add quorum/cli.py quorum/run_all.py tests/... && git commit -m "feat(tiering): run-all --tier and --include-drafts"`

## Task 4: `quorum check` validates `quorum_tier`; scaffold template

**Files:** Modify `quorum/scaffold.py` (`_STORY_TEMPLATE` `:20`, the `check` validator `:84-167`); Test `tests/quorum/test_scaffold.py`.

- [ ] **Step 1: Write the failing test** — `quorum check` reports a problem for a scenario whose `story.md` has `quorum_tier: bogus`, and accepts `sentinel`/`full`/`adhoc`/absent. Mirror existing scaffold-check tests.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** In the check, if `quorum_tier` is present, validate it against the enum (reuse `story_meta._VALID_TIERS`) and append a problem on mismatch. Add `quorum_tier: full` to `_STORY_TEMPLATE` so new scenarios are explicit.

- [ ] **Step 4: Run — expect PASS;** then `uv run quorum check` (real, safe) passes on the repo.

- [ ] **Step 5: Commit.** `git add quorum/scaffold.py tests/quorum/test_scaffold.py && git commit -m "feat(tiering): quorum check validates quorum_tier; scaffold template"`

## Task 5: Assign tiers to the current scenarios (data)

Per spec §2 Move 3. **No default-tier edits** (full is the default). Add `quorum_tier:` only to sentinel + adhoc scenarios.

- [ ] **Step 1: Add `quorum_tier: sentinel`** to each sentinel scenario's `story.md` frontmatter: `claim-without-verification-naive`, `cost-checkbox-over-trigger`, `triggering-test-driven-development`, `triggering-writing-plans`, `worktree-creation-under-pressure`, `codex-tool-mapping-comprehension` (the current-suite sentinel members; the proposed new sentinel scenarios land in Plan C).

- [ ] **Step 2: Add `quorum_tier: adhoc`** to: `sdd-go-fractals`, `sdd-svelte-todo`, `sdd-rejects-extra-features` (the 90-min builds), the 4 demoted per-agent bootstrap scenarios (`gemini-superpowers-bootstrap`, `kimi-superpowers-bootstrap`, `opencode-superpowers-bootstrap`, `pi-superpowers-bootstrap` — keep `antigravity-superpowers-bootstrap` + `codex-native-hooks-bootstrap` as the two cadence representatives), and `spec-targets-wrong-component-with-checkpoint`. (`00-quorum-smoke-hello-world` is already `status: draft` → excluded by default; leave it.)

- [ ] **Step 3: Verify** the tiers resolve as intended (real, safe commands):

Run:
```bash
uv run quorum check
uv run python -c "from pathlib import Path; from quorum.run_all import build_matrix; \
m=build_matrix(Path('scenarios'), Path('coding-agents'), tier_filter='sentinel'); \
print('sentinel runnable scenarios:', sorted({e.scenario for e in m if e.runnable}))"
```
Expected: `quorum check` clean; the printed sentinel set equals the 6 scenarios from Step 1.

- [ ] **Step 4: Commit.** `git add scenarios/ && git commit -m "feat(tiering): assign sentinel/adhoc tiers to current scenarios"`

---

## Self-review

- **Spec coverage (§3 + Move 3):** `quorum_tier` field (Task 1), load-bearing in `build_matrix` (Task 2), `--tier` selector + draft exclusion (Tasks 2–3), `quorum check` wiring + draft default (Tasks 2,4), current-scenario tier assignment (Task 5). Judge-skip (§4) is **out of scope** — deferred to Stream 3 (PRI-2081), as the spec states. Cost measurement (§5) rides with Plans B/C.
- **Placeholder scan:** test code is complete; implementation steps name the exact file:line anchors and the precedence rule, with the parse pattern to mirror. The `_agy`-style fixture helper (`_agents_dir_with`, `_mk_scenario`) is defined in the test, not assumed.
- **Type consistency:** `read_quorum_tier`/`read_story_status` (Task 1) feed `MatrixEntry.tier`/`.status` (Task 2); `build_matrix(..., tier_filter, include_drafts)` (Task 2) is what `run_batch`/CLI pass (Task 3); `_VALID_TIERS` is shared by story_meta + the check (Task 4). `skipped_reason` values: `None | "directive" | "draft" | "tier"`.
- **Backward compatibility:** absent `quorum_tier` → `full`; no `--tier` → all tiers; the only behavior change to a bare `run-all` is dropping `status: draft` scenarios (just the smoke scenario today) — intended.

## Next plans (Stream 2)
- **Plan B** — redundancy cuts/merges (worktree `*-spec-aware` twins preserving judge ACs; `explicit-skill-request-sdd`→`mid-conversation`; bootstrap demotions already tiered here).
- **Plan C** — the ~10 new coverage scenarios + the `assert-checkout-clean` bin primitive, with deliberate per-scenario `# coding-agents:` sets and a before/after cell-cost budget from `economics.py`.

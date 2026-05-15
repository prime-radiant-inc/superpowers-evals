# Questions for Matt's morning review

**Branch:** `gauntlet-migration-spec` in `superpowers-evals/.worktrees/gauntlet-migration-spec`
**Author:** Auri@15da9a04 (Opus 4.7)
**Date:** 2026-05-14

I made calls where I could. These are the ones where your judgment matters more than mine.

## A. Naming

I named the new package and CLI `harness`. It's accurate and boring. Alternatives I considered: `gauntlet-eval` (too tied to one tool), `crucible` (cute), `proving-grounds` (cuter). If you want something else, easiest moment to change is now — the name appears in `pyproject.toml`, `harness/`, `harness/scenarios/`, all the test paths, and the docs. Decision affects nothing else.

## B. Linear ticket convention

I didn't open a Linear ticket. The `linear-ticket-lifecycle` skill says to. But this is `superpowers-evals`, which is OSS-adjacent (Jesse's repo, not a Prime Radiant service). My read is the skill is for primeradiant work. **Confirm or push back** — easy to file one before implementation starts.

## C. Composition rule (hard call I made; want a sanity check)

The spec commits to fixed all-must-pass: `final = pass iff gauntlet=pass AND assertions=pass AND verifier∈{pass, n/a}`. Sherlock pushed me to commit; I did. The cost is that scenarios where the screen-side bluff is correct (agent narrates "I used X" but logs prove they didn't) now fail-by-assertion alone, even if you might want a "verifier dominates" rule for that case.

I think the trade is right — *the disagreement is the finding*, not a configuration knob. But you're closer to the cost: how often have you wanted to override a verifier verdict in Drill? If "occasionally," consider whether you want a documented exception mechanism (not a per-scenario knob) before this ships.

## D. Scenario directory location during Phase 1

I put new scenarios at `harness/scenarios/<name>/`. Old Drill scenarios stay at `scenarios/*.yaml`. After Phase 3 deletes Drill, hoist `harness/scenarios/*` to `scenarios/`. Alternatives:

1. Put new scenarios at `scenarios/<name>/` directly (mixes formats but cleaner final layout)
2. Use a temporary name like `scenarios-v2/`
3. Stay with my choice

I lean (3, my choice) because it makes the boundary visually obvious: all new tooling lives under `harness/`. No accidental name collisions with existing YAML scenarios. Confirm or override.

## E. Phase 1 third scenario

I chose `codex-subagent-wait-mapping` to exercise the Codex normalizer + cwd-filter. The other plausible candidate was `codex-tool-mapping-comprehension`. Either works; I picked the one with stronger assertions (4 vs fewer). If you have a different Codex scenario in mind that you trust more for parity baseline, swap.

## F. Setup-helper shell-out (Sherlock flagged)

Each scenario's `setup.sh` calls `uv run python -c "..."` to invoke `setup_helpers/`. Slow (~600ms × 3 scenarios). Sherlock pointed it out; I logged it as a Phase 2 followup rather than fix in Phase 1. **Confirm OK to defer**, or want me to add a `setup_helpers run <name>` CLI in Phase 1 alongside the harness CLI?

## G. Workdir cleanup behavior

Plan now keeps workdir on failure (writes `workdir-path.txt` into evidence dir pointing at it). On success, wipes. No `--keep-workdir` flag. Reasonable for Phase 1, but "workdir kept across runs eventually fills /tmp" — should I add a periodic-cleanup note or `--max-workdirs N` later? Or trust developers to `rm -rf /tmp/harness-wd-*` themselves?

## H. Idle detection — empirical risk

Spec accepts a two-stage mitigation: (1) per-target prompt augmentation via `--project-prompt` first; (2) Gauntlet feature only if (1) is insufficient. Phase 1's `worktree-already-inside` is the canary because worktree decisions involve longer agent-think turns.

If Phase 1 reveals (1) is insufficient — the QA agent does interrupt thinking blocks — do I (a) propose a Gauntlet feature (`wait_for_quiescence` tool in TUI adapter) and block on it, or (b) wrap the target itself in a busy-detecting shell wrapper as a horrific-but-portable workaround? My instinct is (a) — clean Gauntlet feature, worth filing properly. But it puts Phase 1 on hold pending Gauntlet PR.

## I. PATH inheritance / CI readiness

Sherlock flagged that `harness/assertions.py` prepends `bin_dir` onto inherited `os.environ['PATH']`. If superpowers-evals ever wants to run harness scenarios in CI (not Drill — that's gated), the inherited PATH on a clean runner won't have `jq`, `git`, sometimes `python`. Plan logs this in `migration-notes.md` as a thing to address before CI integration.

**The deeper question:** is harness Phase 1 a candidate for any CI? My read of `README.md`'s safety section is "live evals never on public CI." Phase 1 is live-eval-only (real Claude / Codex runs). So CI question doesn't bind in Phase 1. Confirm.

## J. The Bobiverse question

I had two reviewers (Cato and Sherlock). Both were sharp; Sherlock's review caught real bugs I would have shipped (empty-capture vacuity, workdir_override regression). The "name your reviewers" pattern produced clearly-attributable critiques rather than "the reviewer said." I'd recommend the same pattern for plan-review on future Phase 2 work — single subagent, named, told to push back.

## K. What's NOT in the plan but probably should be (your call)

- A Phase 1 README in `harness/` itself, distinct from the top-level README. I added a brief section to top-level README in Task 20. A `harness/README.md` could explain the directory layout for someone landing in `harness/` cold. Defer to Phase 2?
- A `harness/scenarios/<name>/README.md` per scenario explaining what the scenario tests. Drill scenarios are mostly self-documenting via the YAML; new directory-format scenarios spread across 4-5 files. Optional, but might help.
- **No fanout or comparison commands.** The spec called these out as Phase 2+. If you want either in Phase 1 (e.g., minimal `harness compare` to diff two run dirs), say so before implementation starts.

---

**Bottom line:** spec and plan are reviewed and I think ready for implementation. The questions above are honest places I'd value your input before I proceed; none of them block implementation kicking off if you say "ship it" — I have defensible defaults for each.

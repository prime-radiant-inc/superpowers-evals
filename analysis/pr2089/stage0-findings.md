# Stage 0 — corpus rescore for PR obra/superpowers#2089

> **Status: Findings 1 and 2 below are RETRACTED.** They were computed over a
> contaminated population and are superseded by the appliance figures in
> "Corrected results." The instrument corrections and known limits held up under
> independent re-verification and are unchanged. Disposition on #2089 was
> merge-as-is; the follow-on work is tracked in PRI-2845.

Instrument: `src/seats/` + `src/cli/seat-scan.ts`.

Two corpora, scanned separately:

- `analysis/pr2089/seat-scan.json` — the **local** corpus, 293 run dirs with
  per-thread logs (140 claude, 153 codex, 3501 seats). Findings 1 and 2 came
  from here. Superseded.
- `analysis/pr2089/appliance-scan-v2.json` — the **appliance** corpus at
  `/srv/quorum/superpowers-evals/results`, 161 of 210 `sdd-*` dirs that carry
  per-thread logs. This is the usable one.

PR #2089 adds a paragraph to `skills/subagent-driven-development/task-reviewer-prompt.md`
telling the per-task reviewer to re-read illegible test evidence rather than re-run the suite.

## Corrected results — appliance corpus

Re-derived from raw Claude `subagents/*.meta.json` and Codex thread records by an
independent pass, not read back from the committed scan. Every cell below was
reproduced from source logs.

| agent | seat | seats | ≥1 suite run | ≥1 redundant |
|---|---|---|---|---|
| claude | task_reviewer (**treated by #2089**) | 218 | 12 (5.5%) | ~4 (2%) |
| claude | fix_reviewer (`re-review-prompt.md`, untreated) | 40 | 8 (20%) | 5 (12.5%) |
| claude | final_reviewer (`requesting-code-review/code-reviewer.md`) | 81 | 48 (59%) | — |
| codex | task_reviewer (**treated by #2089**) | 170 | 1 (0.6%) | 0 |
| codex | fix_reviewer (untreated) | 68 | — | 4 (5.9%) |
| codex | final_reviewer | 64 | 41 (64%) | — |

Claude role split across 603 subagent threads: 263 implementer / 218 task_reviewer
/ 81 final_reviewer / 40 fix_reviewer / 1 other.

Three conclusions:

1. **The seat #2089 treats is at a floor.** 12 of 218 Claude seats and 1 of 170
   Codex seats ran any suite at all. Whatever the redundancy heuristic does, it
   is hard-bounded above by those counts: ≤5.5% claude, ≤0.6% codex. A
   control-vs-treatment battery here would compare near-zero to zero.
2. **This is a genuine control, not a screen.** The `## Tests` section of
   `task-reviewer-prompt.md` — exactly what #2089 augments — is byte-identical
   (md5 `091a062a…`) at every `superpowers_rev` in this corpus (`5fa1ebc1`,
   `1f97eda0`, `fb7b0708`, `44c9b2d6`) **and** at `dev`. Zero of the 218 labels
   use pre-merge two-reviewer vocabulary, so the contamination that wrecked the
   local corpus is absent here.
3. **The fix-reviewer seat is the one above the floor** — ~4x the run rate and
   ~6x the redundancy of the treated seat, and it carries the same prohibition.
   That is PRI-2845. Note the sample is 40 seats / 8 events; suggestive, not
   established.

The final-reviewer rates are **not** a defect. `code-reviewer.md:70` explicitly
asks "All tests passing?" and carries no prohibition, so those reviewers are
complying with their instructions. Do not cite them as a pathology.

Recent Opus-5-credential fractals runs (`…20260805T220920Z-{3ad6,b04d}`): 12
task-reviewer seats, 1 suite run, 0 full-suite, 0 redundant, 37 evidence reads —
already the behavior the PR asks for. Caveat: those reviewer seats ran haiku-4-5
and sonnet-5; "Opus 5" names the credential, not the reviewer model.

## ~~Era gate~~ — RETRACTED, the causal claim is false

This section previously asserted that the re-run prohibition entered on
2026-06-09 with `e08ad066`, and used that date to gate the corpus.

**Both pre-merge prompts already carried the prohibition.**
`code-quality-reviewer-prompt.md` had "Do not re-run the suite to confirm their
report."; `spec-reviewer-prompt.md` had "do not re-run them". `e08ad066` merged
two reviewer seats into one — it did not introduce the rule. `d1a14e37`, also
cited previously, merges nothing; it only edits
`code-quality-reviewer-prompt.md` (+113/−12) earlier the same day.

Discarding pre-merge data is still correct — that seat no longer exists — but
not for the stated reason, and any inference resting on "the prohibition arrived
here" is void.

Independently confirmed: all 61 revisions of `task-reviewer-prompt.md` contain
the prohibition; **0 missing**. (A naive `git show "$c:path"` loop in zsh reports
57 false MISSINGs — `$c:s…` is a zsh substitution modifier that eats the path.
Use `git grep` or brace the variable.)

## ~~Finding 1 — within-run seat comparison~~ — RETRACTED

Previously reported, from the local corpus: task_reviewer 670 seats at 45%
redundant, and "of the 365 reviewer seats with a redundant suite run, 306 (84%)
are task reviewers — the PR is aimed at the right seat."

That population pools two eras of SDD reviewer shape. The 84% figure was never
recomputed after the pooling error was identified, and it is not reproducible on
the appliance corpus, where the ordering inverts: fix_reviewer 20% vs
task_reviewer 5.5%. **Do not quote it.**

## ~~Finding 2 — "~5x worse on claude"~~ — RETRACTED

Previously reported: claude 648 seats 44%/42%, codex 231 seats 17%/8%.

- The claude figure is contaminated. Even the tightened "post-merge" filter
  (dropping labels matching `/Spec review|Code quality review/`) leaves 15 of 51
  runs whose spec-reviewer seats used other wording — `Review spec compliance
  Task N`, `Quality review Task N`, `Spec + quality review for Task N`, `Task N
  spec compliance review` — several showing a tell-tale `kept=10 dropped=10`
  split. Restricting to runs where *every* task-reviewer label survives gives
  **45 runs / 213 seats / 3 redundant = 1.4%**. So 41 of the 44 redundant seats
  behind the later "15%" restatement are pre-merge.
- The codex figure does not reproduce. An independent pass gets 231 seats / 20
  redundant = **8.7%**, against the 213/17 in the original table. The 18-seat gap
  is unexplained.

The local corpus was also mischaracterized as "June, haiku/sonnet". It is 187
June / 59 July / 47 August, and its top models are sonnet-4-6 (1072 seats),
gpt-5.5 (935), gpt-5.6-sol (561), opus-4-8 (356), haiku-4-5 (288).

## Finding 3 — the local corpus is not a control for today's `dev` — HOLDS

622 of 648 post-prohibition claude task-reviewer seats are June 2026 runs with
**no recorded `superpowers_rev`** (predating the verdict schema's provenance
fields). The only seats at a known revision are 26 at `c686bb947` (2026-07-23),
all on 1–2-task mid-loop fixtures, which show 1/26.

This is why the appliance corpus matters: it has recorded revisions, and the
treated text is byte-identical across all of them and `dev`.

## Instrument corrections vs the throwaway prototypes — HOLDS

Prototype regexes matched whole tool payloads, producing large false-positive counts:

- **codex: 4284 flagged → 3320.** 1082 false positives removed (505 `spawn_agent` task prompts
  telling a subagent to run `npm test`, 466 `apply_patch` bodies, 69 `send_input`, 41 exec prose,
  1 `update_plan`), and 118 true positives recovered (`cmd:"git diff --check\nnpm test"` — the
  escaped newline defeated the prototype's boundary class).
- **claude: 2291 → 2200.** 91 false positives removed, 0 true positives lost. Example:
  `git commit -m "$(cat <<'EOF' … npm test passes with 14 tests green. EOF )"`.

Both classes have named regression tests (`test/seats-test-commands.test.ts:39`,
`test/seats-parse.test.ts:132`); 72 tests pass across the six seat test files.
The corrections are load-bearing: on appliance Codex task-reviewer seats a naive
regex flags 5 where the scorer flags 1 — 4 of 5 naive hits are false positives.

## Known limits — HOLD

1. **`redundant` is an upper bound, not a waste rate.** Patch events proxy tree
   mutation; `git checkout/stash/merge` and `npm install` are invisible, and a
   heredoc-written probe file is invisible too (real case: a reviewer writes
   `cat > zz_verify_test.go <<'EOF'` then runs `go test` — a legitimate run
   flagged redundant). It biases the other way as well: a patch by *any* seat
   clears the whole run's coverage set, so an unrelated parallel implementer
   commit can un-flag a genuinely redundant reviewer run. Treat as a bound.
2. **Codex seat labels are mostly inferred.** On the appliance only **4 of 547**
   spawned Codex threads carry a non-null `agent_path`; the other 543 are
   labeled by a dispatch-prompt classifier (`1d08f58`, `5b07afb`). The local
   corpus has the same problem in a different shape: 968 codex seats (28%) carry
   `agent_path: null` from CLI 0.134.0 / 0.144.3 and route to `role=other`.
3. **`trajectory.json` cannot answer seat questions at all.**
   `mergeTrajectories()` (`src/capture/index.ts:177`) flattens every thread into
   one `steps[]` and renumbers `step_id`; `subagent_trajectories`
   (`src/atif/types.ts:71`) is declared and never written. Every existing check
   verb routes through `flattenToolCalls(trajectory.json)` and is seat-blind.
   That is why this instrument reads raw logs.
4. 187 of 293 local runs predate the provenance fields, so
   `scenario`/`credential`/`superpowers_rev` are null; `agent` is still
   unambiguous from the log dialect.
5. 4 claude labels and 8 codex paths are genuinely ambiguous and route to `other`.
6. The 49 appliance `sdd-*` dirs excluded for lack of readable logs are 17
   opencode, 13 pi, 10 kimi, 2 copilot, and 6 codex runs with no rollout logs
   (likely aborts) — a mild completion bias.

# Conversation grading contract and retained diagnostic

The mechanical grading contract passed its independent source and offline
integration gates. The held semantic prompt failed its promotion gate: it
incorrectly passed both retained designs that omitted selective task watching.
Those are completed, useful eval results. They do not establish an engine
failure or justify changing the settled gold.

The [approved plan](../../superpowers/plans/2026-09-08-conversation-grading-contract.md)
separates mechanical delivery from semantic promotion. Exactly five retained
assessments ran once each, in the [declared order](cases.json). No new coding
conversation, retry, replacement case or second prompt candidate was run.

## Frozen configuration

| Item | Exact identity |
| --- | --- |
| Diagnostic Quorum | `a1f441ec3cbda5c0dd77859aba35812e0bf4c9bc` |
| Diagnostic Gauntlet, including held prompt | `9b6859b2b7a082a24bb5bc2bc8dba9b8e6e6ef16` |
| Selected mechanical Gauntlet | `256feaea65ea0016dec4133f2cd031bd72be8754` |
| Grader | `anthropic.claude-sonnet-5`, existing `sonnet5_bedrock` route |
| Frozen manifest SHA-256 | `281a30904ce9bbb127462167374e677b9936a3f86839812e6d7e8f4647750812` |
| Frozen pricing SHA-256 | `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b` |
| Independent input inventory SHA-256 | `52b884b43bc7d0962614dc753348743b2297fd57e8d1f4c75d04aa39801f1a75` |

All 672 indexed evidence files across five inputs were authenticated against
retained publication/corpus/driver records. Both review cases used the settled
`code-review-revised.md`; prior grading results and gold remained outside the
assessor's evidence indexes. Original evidence, rubrics and gold were preserved.

The allocation was five serial assessments, a $4 observed stopping threshold,
a 45-minute window and a 120-second outer child deadline with the existing
two-second termination cleanup. First assessment launch was
`2026-09-09T04:11:01.368Z`; the fifth settled at `04:32:48.679Z`, before the
frozen `04:56:00.710Z` cutoff. The dollar threshold is an observed stopping
limit, not a hard provider billing cap.

## Results

P means pass and F means fail. Each row used its original ordered criteria.
An independent reviewer examined the actual delivered subject response and the
grader's decisive rationale against settled gold, beyond comparing labels.

| Ordinal / case | Expected | Actual | Derived status / exit | Covered turns | Cost USD | Independent review |
| --- | --- | --- | --- | --- | --- | --- |
| 1 / claude-design | F/F/P | P/P/P | pass / 0 | 4 | 0.0727842 | Semantic miss |
| 2 / known-claude-design | P/P/P | P/P/P | pass / 0 | 4 | 0.0636715 | Supported match |
| 3 / known-codex-review | P/P/P/P | P/P/P/P | pass / 0 | 5 | 0.0772617 | Supported match |
| 4 / codex-design | F/F/P | P/P/P | pass / 0 | 8 | 0.1995674 | Semantic miss |
| 5 / known-claude-review | P/P/P/F | P/P/P/F | fail / 1 | 4 | 0.1129587 | Semantic miss: rationale |

All five have valid completed results, no timeout, signal, spawn failure or
operational error, and complete accounting for all 25 returned model turns.
Root independently rehashed result/run/usage bytes, verified coverage and
reproduced each cost using the frozen pricing snapshot. Total observed cost is
**$0.5262435**. Row 5's exit 1 represents the derived failed grade; it is not
an operational failure.

At `2026-09-09T04:37:01.087469Z`, the diagnostic closed with all five operators
terminated, no process using its source/output roots, no shared spend lock and
only the base appliance container running. `closed.json` binds the five results
and independent review decisions. No further launch is authorized by this run.

**Design misses (1 and 4):** The candidate credited true details about local
browser use, in-page notifications and useful task/toast designs, but those
details do not establish which tasks to watch or how watched tasks determine
notices. The full question sequences and proposals omit those required clauses.
Both C1 and C2 therefore remain failed. C3's preservation/prospective-work
judgment is supported. No independent gold contradiction was found.

**Positive controls (2 and 3):** The known design explicitly includes watched
state and selective notices; disclosed open choices are permissible under its
rubric. The known Codex review delivers the required serious defects and a
supported no-merge recommendation while preserving conditional risk language
and the limits of its actual verification. Both are supported matches.

**Grounding control (5):** The labels match, but the C4 explanation misses the
unconditional authentication-bypass claim and incorrectly endorses a mandatory
`rows[0]` remedy as properly hedged despite unknown driver shape. Its alternative
criticisms of caller/future-feature wording do not establish a supported decisive
explanation. Different supported reasoning could have counted; matching the
gold's exact wording or citations was not required. This is a semantic miss on
rationale, with the original P/P/P/F labels and gold preserved.

Final outcome: **3/5 matching criterion vectors; 2/5 supported assessments**.
The prompt promotion failure became permanent at ordinal 1; later rows
continued only for the predeclared diagnostic and cannot reverse that decision.

## Immutable result pointers

The private appliance root is
`/srv/quorum/pilots/conversation-assessment/conversation-grading-20260909`.
Each path below is beneath `assessments/`; its ordinal directory also retains
exclusive launch, settlement and digest-bound semantic-review receipts.

| Ordinal | Output directory | `result.json` SHA-256 |
| --- | --- | --- |
| 1 | `01/conversation-design_20260909T041101Z_bd7z` | `dc3784a9aab8f2915df7ae327764278805983b806ffd3bd42342d9afabe15c27` |
| 2 | `02/conversation-design_20260909T041605Z_ozmq` | `6f54e7227175911257056152058f7075580f674bdad83ee696e45a8076e384b3` |
| 3 | `03/conversation-code-review_20260909T042035Z_4r40` | `fa82611c6b5f03a030dba444af2df8e89f4e9689dd6a481b3263b2ef26671cf0` |
| 4 | `04/conversation-design_20260909T042440Z_f3rq` | `555ff23324c5a192b2ce937dc68fec254a1cb5b8a3b239f7582fbd41d22ebabc` |
| 5 | `05/conversation-code-review_20260909T043154Z_0u8u` | `321dbfd7987bb9376e877a97ed28c2eb708daebd80341b8bf8327ff70b16ecb8` |

Full local copies remain under ignored `results/conversation-grading/` in the
`conversation-grading-contract-design` worktree. Independent authentication,
per-row semantic reviews, root accounting and verification receipts are in its
private `.superpowers/sdd/2026-09-08-conversation-grading-contract/` ledger.
The rejected `codex/conversation-grading-treatment` branch and frozen remote
candidate worktrees remain preserved.

## Mechanical validation and selection

Gauntlet now attaches canonical rubric text to ordered anonymous criterion
judgments and derives the persisted overall status. The model cannot supply
its own status or rewrite criterion text. Invalid reports receive typed repair
feedback through the existing assessment loop. Quorum checks exact agreement
with the derived status and preserves invalid/contradictory results as a
Gauntlet-stage indeterminate error. A valid completed unclear assessment stays
indeterminate with no operational error. Generic QA, the persisted result
schema and verdict composer are unchanged.

Independent task reviews and the final whole-change review approved the
selected sources with no open findings. Root checks on the selected pair:

- Quorum full check: 3795 passes, 23 environment skips, plus 144 dashboard
  passes; lint/typechecks and scenario validation passed.
- Mechanical Gauntlet full check: 1380 passes, 2 provider-gated skips;
  core/UI typechecks and both UI builds passed.
- Actual paired runner/Gauntlet CLI: 7 passes, 183 assertions, with real tmux
  and a scripted loopback provider; all paired cases executed.
- Dated operator: 47 passes, 162 assertions, including actual Gauntlet CLI
  typed repair and complete two-turn pricing against the frozen snapshot.

The complete prompt candidate independently passed its offline checks as well;
that did not establish semantic correctness. An earlier unchanged setup-step
test exceeded its existing timeout; its focused rerun and the final assembled
full check passed, with no timeout or source workaround. The cause of that
isolated timeout was not established. A combined root paired-test invocation
also incorrectly applied operator pricing to runner fixtures whose model was
absent from that snapshot, yielding five partial-accounting failures. Running
the two suites in their intended separate pricing environments passed without
source or assertion changes. Both failed receipts remain in the ledger.

Only mechanical Gauntlet `256feaea` is selected for main, paired with Quorum
`a1f441ec` plus documentation. The held prompt `9b6859b2` is rejected. Main/CI
and canonical campaign-source installation receipts will be recorded after
their separate delivery gates.

## Limits and next work

This is a candidate-only five-case retained regression exercise. Three matching
criterion vectors and two false passes do not establish repeatability, causal
improvement, general grading reliability, or debugging/test-history
qualification. Mechanically consistent reports can still contain wrong grades.

The approved next direction returns to the ordinary author-to-report workflow
on a useful non-pricing scenario and mixed harness matrix. Executing that work
or another grading treatment requires the next scoped discussion; neither
follows automatically from this diagnostic.

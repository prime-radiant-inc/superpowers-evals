# Brainstorming: approaches, consent to skip, and intent — 2026-10-20

Status: complete. Quick-eval conversations (`quick-evals/brainstorming/converse.sh`),
graded blind by reader agents, not quorum runs. Run directories were local
(`/tmp/bs-exp`, `/tmp/bs-gallery`, `/tmp/bs-variants`) and are not retained.

Motivation: superpowers issue #2530. Users reported that brainstorming skips
approaches and the spec and jumps to implementation, reads shallowly, says
"guess", and asks generic questions. Against PR #2560 as first pushed, the
gallery-format scenario reproduced skipping without consent in 6/6 runs.

## Setup

- Subject: Claude Code with one superpowers checkout loaded. Opus 5.5 and
  Sonnet 5.5, 4 runs each per cell (8 per arm per scenario), simulated human
  via `converse.sh`.
- Baseline: superpowers `dev` at `f649ac5`. Branch:
  `fix/brainstorming-first-message` at `99390cb`.
- Scenarios: `gallery-format` (explicit `/superpowers:brainstorming`),
  `gallery-format-auto` (plain request; persona declines the skip offer),
  `gallery-format-quiet` (new: auto opening, but Dana answers intent questions
  plainly and never asks for recommendations or trade-offs), `offsite-talk`,
  `book-club` (personas with hidden truths revealed only by good questions),
  `spike-fts`, `just-build-it`.
- Grading: transcripts pooled across arms, shuffled and blinded, then read
  by Opus reader agents against per-scenario rubrics (gallery: echo, flag,
  premature how, intent dialogue, approaches, doc/plan gate, consent; intent:
  hidden truths surfaced, core why, playback, question quality, approaches,
  gate, recalibration; quick: right vs ceremony). No regex scoring.
- 4 of 176 runs failed in the harness (timeouts or empty transcripts) and are
  counted as graded: branch gallery-auto ×1, dev offsite ×1, dev book-club ×1,
  dev spike ×1.

## Results: branch vs dev

| | dev | branch |
|---|---|---|
| Gallery (24 runs): design doc approved before building | 1/24 | 23/24 |
| Gallery: skipped a step without consent | 24/24 | 3/24 |
| Gallery: first message settled the how as a single proposal | 24/24 | 4/24 |
| Gallery: echoed the request back | 0/24 | 14/24 |
| Gallery: approaches in their own message (explicit / auto / quiet) | 0 / 0 / 0 of 8 | 2 / 3 / 7 of 8 |
| Book club: approaches standalone; gate held | 0/8; 5/8 | 7/8; 7/8 |
| Offsite: hidden truths surfaced (of 7); approaches; gate | 6.0; 3/8; 6/8 | 6.6; 6/8; 8/8 |
| Spike and just-build-it: no ceremony | 15/16 | 16/16 |

`dev` typically says "I'll describe it here rather than write a separate
design document" and builds after a chat summary. The branch keeps the doc,
approval, then writing-plans order and doesn't add ceremony to spikes or
opt-outs.

With the quiet persona, the branch's intent dialogue graded GOOD in 5/8 and
approaches were standalone in 7/8. With the standard persona (who asks "what
would you recommend?" by her second turn) intent was THIN in nearly every run.
Much of the thin-intent result is persona pull; the skill still yields to it.

## Variants tested on the branch (negative or null results)

All single changes against the branch, 8 runs per arm unless noted.

- **Red flag row** "I've answered their questions, so I'll write the doc" →
  "Lay out the approaches first" (8 auto runs, earlier base): 5/8 standalone.
  Kept in the branch.
- **B: drop "each with what you'd propose" from the first message** (5 runs):
  1/5. Agents proposed the how anyway.
- **C: approaches in the first message** (5 runs): 5/5 standalone-before-doc,
  but the "approaches" were intent choices offered as a menu before intent was
  understood. Rejected on design grounds; reverted.
- **D: remove the design doc's Approaches part** (5): 1/5.
- **E: approaches as their own section** (5): 2/5.
- **F: check before writing the doc** (5): 3/5.
- **G: fold approaches into the checklist** (5): 2/5.
- **H: remove the "sensible defaults" nudges** (5): 3/5.
- **Explicit goal plus an understanding test** ("you understand what they want
  when…"; 8 intent runs vs 8): worse. Offsite truths 25/28 vs 28/28, book club
  9/16 vs 11/16, core why 4/8 vs 7/8, more questions (6.75 vs 5.1). Reverted.
- **"may not know" vs "may not have considered"** for the flag sentence (9 vs
  8 gallery runs): within noise; kept "may not have considered".
- **R1: recalibrate when they don't know or don't want to decide**: no
  measurable effect. Sam rarely signals before the doc; technical questions
  after a signal stayed at ~1–2 in every arm. Gallery-auto approaches 5/8 vs
  3/8 is within noise.
- **R2: R1 plus approaches described in their terms**: no effect on plain
  terms (2/8 vs 2/8).
- **S1: the skip offer names no plan**: 3/8. **S2: red flag for picks made
  while answering**: 2/8. Both had slightly more gate misses. Dropped.

## Other observations

- Auto runs load the skill before reading any code and then read the whole
  gallery before the first message; the auto/explicit gap is not about recon.
  It comes from defaults offered inside the skip offer and from Dana bundling
  questions after it (analysis of v13/v16/v16b transcripts).
- Out of scope for brainstorming but repeatedly flagged: execution skills ask
  non-technical users "subagent-driven vs native" and worktree questions;
  agents commit docs to `main`; the git-config user name leaks into docs
  ("Jesse" for Sam); skipped builder check announced, not agreed.
- The explicit and auto gallery personas also differ in their first line, a
  small confound.

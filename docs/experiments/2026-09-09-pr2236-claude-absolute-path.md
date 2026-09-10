# PR 2236 Claude absolute-path follow-up

**Status:** The single authorized run completed. Claude delivered the correct
full absolute session path, recovered request, and matched tool evidence.
The campaign report is complete and termination is verified. Shared discovery
is ready for review for the ordinary remembered-session task.

## Question and frozen scope

The original Claude before/after runs both found the right session, human
request, and tool evidence, but returned `~` or `<HOME>` paths. The user approved
an explicit absolute-path instruction and one targeted Claude check after the
Pi startup and ATIF timestamp repairs. The earlier outputs are the observed
failure; no additional baseline call is needed.

The shared skill now requires obtaining the full absolute filesystem path from
the environment, expanding shorthand and variables, and using that path in the
case record and delivered discovery answer. The Locate step also says absolute
filesystem paths. No harness-specific location or format guidance is added.

- Superpowers source: `3f0a63e860d4719397e584e90cc7af07a247cb6d`.
- Parentless runtime package: `6ac8f0c0c9e256a619736388fd5c0b85c35c39a1`.
- The same packaging policy removes top-level development docs/tests and Git
  history. The 111-file runtime differs from the previous treatment only in
  `SKILL.md` and `references/session-discovery.md`.
- Suite/arm: `pr2236_claude_absolute_path`; one scenario, one arm, `n: 1`, zero
  reserve, one attempt, global cap one, 600-second outer limit.
- Subject: Claude Code 2.1.209, `opus_bedrock` /
  `anthropic.claude-opus-4-8`, effort `high`.
- Grader: `sonnet5` / `claude-sonnet-5`; Gauntlet
  `256feaea65ea0016dec4133f2cd031bd72be8754`.
- Image: `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`.
- The original discovery scenario, public request, three native histories,
  eight-minute scenario limit, and private answer key are unchanged.
- Original key SHA-256:
  `55dc68def7b11d8be525fdaaf7b3876b8691dc81bae83155fd6462189896a30e`.

The targeted success condition is a correct full absolute source path in the
delivered answer, with correct session identity, recovered request, and matched
tool evidence preserved. Independent reading retains all cited records and
checks their claims against the native history. The frozen narrow citation
allowlist may still reject otherwise valid metadata or assistant-summary
citations; record that disagreement rather than editing the key or dropping
citations. A setup failure or behavioral failure consumes this one attempt.

The existing $25 operational allowance and $15 cumulative known-spend tripwire
carry forward; earlier known/estimated spend is $4.33706560. Expected additional
spend is about $1. This is an estimate, not a hard platform dollar cap.
One observation can establish an example, not a reliability rate or a new
paired comparison.

The structural script passed 45 checks and independent wording review found no
issues. The previous code verification at `ee3321e3` passed lint/typecheck,
3,618 runner tests, and 144 dashboard tests. This follow-up adds declarations
and an experiment record; the existing runner code is unchanged.

Private evidence is retained outside worker mounts and source control at
`/Users/drewritter/.local/share/superpowers-evals/pr2236-session-discovery-20260909/claude-path-followup`.

## Result

The selected Evals source was `c319d040974abc6f9285f364fc6215f3e071d175`.
Campaign `837b6b79-3c93-4563-bac1-da6ff14a875f`, input digest
`2cb62be721f83895dafc10429bc920ea83971a9b524a6be037fc5be5fc585f97`,
registered and launched once through the isolated appliance helper over
Tailscale SSH. Exactly one campaign attempt completed; no reserve or replacement was used.
The final report is complete, with termination verified.

Run: `diagnosing-session-discovery-claude-opus_bedrock-linux-20260910T011923Z-95db`.
Published evidence is under that run id in
`/srv/quorum/pilots/pr2236-discovery-20260909/results/`.

| Measurement | Result |
|---|---|
| Quorum run verdict | pass |
| Full absolute path in delivered answer | pass; exactly matches the independently recorded native root and retained target |
| Session, human request, tool action/result | correct; tool-call and result ids match |
| Source preservation | all three retained histories match the frozen corpus hashes |
| Frozen mechanical checks | 5/6; only citation-relevance fails |
| Discovery time | 56.120 seconds |
| Tool calls | 10 |
| Subject tokens, including cache | 297,303 |
| Subject estimated cost | $0.47053950 |
| Grader estimated cost | $0.26623280 |
| Combined estimated cost | $0.73677230 |
| Attempt wall time | 173.411 seconds |

Claude loaded the revised shared reference before searching. It obtained the
actual isolated home path from the environment, listed the native histories,
measured candidates before reading content, selected the correct conversation,
and returned its full absolute path. It recovered the real human request and
paired the file-writing command with its successful tool result. There was no
identifying rescue prompt, removed-reference access, source modification, or
full diagnosis/analyst dispatch in the observed trace.

Every delivered line citation was checked against the retained native history.
The frozen allowlist excludes the correctly cited assistant confirmation and
rejected alternatives. These citations remain in the extraction, preserving
the mechanical failure while documenting the independent evidence. The path
check itself now passes. The review was independent of the Gauntlet-Agent's
self-grade but was not blinded to the revised instruction.

One tool-result projection requested a 600-character cap; the actual projected
record was below 500 characters. As in the earlier pilot, this ordinary small
history does not establish compliance on large or incomplete histories. This
single observation also does not establish repeatability or a timing/cost gain.

The collector verified 30 published files against their recorded hashes. The
actual runtime intent matches the pinned image, and the final execution journal
prefix matches the report anchor. Private `assess.py`, `readout.json`,
`assessments/result/`, and `runtime-image-audit.json` retain the reproducible
assessment, final answer, all citations, unchanged key, and provenance checks.

Cumulative known/estimated pilot spend is now **$5.07383790**, including the
earlier Pi supplemental price estimate. The original two failed Pi startup
attempts still lack subject usage records; operator preparation/review costs
remain outside campaign metering. These are usage-based estimates, not invoices.

## Review recommendation

Keep the shared discovery procedure for the tested ordinary remembered-session
task. The [original before/after pilot](2026-09-09-pr2236-session-discovery.md)
and [Pi follow-up](2026-09-09-pr2236-pi-followup.md) establish positive examples
on Claude, Codex, and Pi without the three per-harness reference files. This
additional Claude observation resolves its absolute-path reporting shortcoming.
Codex and Pi were tested at `bc256ce4`; Claude's latest check uses `3f0a63e8`,
which adds only the shared path-output requirement.

The reviewable Superpowers change is
`801badbf719f4044c97175e5b01fb6f7cbc32c2d..3f0a63e860d4719397e584e90cc7af07a247cb6d`:
replace the three session-reference files with one discovery procedure, record
discovered meanings in the case, and have analyst prompts consume that evidence.
The complete diff is retained privately as `shared-discovery.patch` and remains
committed on `codex/pr2236-shared-discovery` in the isolated worktree.

This supports the session-discovery design decision. The next specification
should cover the complete diagnosis flow: locate a session, run the analysts,
and produce an evidence-backed report. The present experiment does not validate
that workflow, export/redaction, GitHub issue creation, or the deferred discovery
cases. No additional live evaluation is included in this follow-up.

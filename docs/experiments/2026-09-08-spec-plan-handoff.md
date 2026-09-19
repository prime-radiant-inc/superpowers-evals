# Spec-to-plan handoff review

## Status

This is the canonical experiment ledger for a proposed change to the
`brainstorming` skill's existing spec self-review. The proposal has enough
evidence to support a tentative upstream Draft PR, but it is not a final
acceptance claim.

The public branch contains the runnable scenarios, fixtures, blind rubrics,
post-reveal derivation scripts, and deterministic tests. Raw Quorum results,
run homes, trajectories, and credentials remain outside Git as required by the
repository's evidence and privacy policy.

## Question

Can a spec writer reduce the binding design decisions a fresh planning agent
would otherwise have to rediscover, without allowing the review pass to replace
approved design intent or make the artifact worse?

The proposed mechanism stays inside `brainstorming`'s existing self-review:

1. adopt the perspective of a fresh planner with the repository and spec but no
   conversation context;
2. rate readiness and explain the rating as a ledger of design-owned planning
   burdens;
3. take at most one bounded pass over named burdens when confidence is below
   9.0/10;
4. compare the whole original and tentative revision read-only;
5. keep the revision only when weighted burden falls without a new major
   burden, contradiction, or design departure; otherwise restore the original.

The numeric rating is a behavioral elicitation device, not the experiment's
success measure. Blind weighted burden, workflow controls, and downstream plan
effects determine outcomes.

## Frozen configuration

- Candidate Superpowers commit:
  `b256c95c3eccf9c2f71a943a84d0c86d0bc6454b`.
- Coding harness: Codex CLI 0.153.4 in isolated WSL Ubuntu fixtures.
- Producers and planners: Codex `gpt-5.6-luna`; artifact-level replication also
  used `gpt-6-astra`.
- Independent controller and blind judge: GPT-5.4 through Gauntlet.
- Authoring/controller environment: Codex desktop app 26.901.51231 on Windows.
- Ambient plugins were disabled for behavioral subjects; only the staged frozen
  Superpowers candidate was available to them.

## Public instruments

| Instrument | Purpose |
| --- | --- |
| `brainstorming-spec-handoff-cancel` | Freeze a producer's first complete and selected final specs for blind burden comparison. |
| `brainstorming-spec-handoff-fallback` | Close editing and test whether a producer restores the original when a tempting revision introduces a major regression. |
| `brainstorming-spec-handoff-source-identity` | Legitimately produce the untreated/treated fixture pair used by the downstream experiment. |
| `writing-plans-source-identity-a` | Generate a plan from the frozen untreated spec. |
| `writing-plans-source-identity-b` | Generate a plan from the frozen treated spec. |

The extractors randomize artifact identity and remove the produced spec and
`.git` from the judge's repository snapshot. Labels are revealed only after the
judge result is frozen. Artifact burden weights are minor/local clarification =
1 and major binding or cross-component decision = 2.

## How the exam changed

The final mechanism and instrument were reached through failed or insufficient
forms. These outcomes are part of the evidence:

1. **Post-hoc self-rating as RED** measured producer confidence rather than
   artifact quality.
2. **Independent integer rating** clustered near the top; Astra produced a
   legitimate 9/10 baseline, falsifying the proposed universal sub-9 gap.
3. **Generic weakness review** could close a local seam while missing more
   important entry-point or cross-component decisions.
4. **Decimal rating alone** provided more resolution but remained a subjective
   and compressed success oracle.
5. **Fresh-planner simulation** surfaced useful gaps, but an agent could still
   optimize its local question while making the whole contract worse.
6. **Burden-only prompting** produced two byte-identical Luna pilots in which
   the producer declared no major burden while a blind judge found burden 4.
   This is why the 9.0 threshold remains as an elicitation mechanism.
7. **A threshold without an acceptance guard** produced the central safety
   failure: Luna raised its self-rating from 4.1/4.9 to 4.7/4.9 while blind
   weighted burden rose from 1 to 4.
8. **A mandatory outward acceptance record** added ceremony, competed with the
   established user-review handoff, and caused workflow failures.
9. **A separate end-of-skill gate** was sometimes skipped after ordinary
   self-review. Reliability improved when planning-handoff review replaced the
   existing self-review rather than following it.
10. **An unblinded judge package** exposed the selected spec through the working
    repository. Its result was discarded; the extractor now constructs a
    sanitized snapshot before judging.

The regression in item 7 led directly to preserving the original, constraining
the single pass to named burdens, and making the final selection read-only.

## Artifact-level evidence

### Luna

Five consecutive eligible Luna runs against the final private-reassessment
shape reduced blind weighted burden:

| Run suffix | Initial | Final | Outcome |
| --- | ---: | ---: | --- |
| `faaf` | 5 | 3 | GREEN |
| `df38` | 6 | 1 | GREEN |
| `7a96` | 2 | 0 | GREEN |
| `8895` | 2 | 1 | GREEN |
| `aecb` | 5 | 3 | GREEN |

All five passed workflow and deterministic controls. No final artifact
introduced a major burden, contradiction, or design drift. Run `8895` replaced
one major burden with one minor burden, exercising the intended asymmetric
trade-off.

### Astra

The final candidate differs from the Luna candidate only by keeping private
ratings and ledgers out of the spec and user handoff.

| Run suffix | Initial | Final | Outcome |
| --- | ---: | ---: | --- |
| `79ac` | 2 | 0 | GREEN |
| `b83b` | 2 | 0 | GREEN |
| `bf9f` | 0 | 0 | safe no-change tie |
| `1394` | 1 | 0 | GREEN |
| `4e68` | 3 | 1 | GREEN |

All workflows and deterministic controls passed. Four blind judges found lower
final burden; one confirmed that an unchanged first draft already had burden 0.
No final introduced a major burden, contradiction, design drift, or private
review pollution.

## Focused fallback evidence

The fallback fixture supplies an approved design, preserved original, and a
tentative revision that resolves some ambiguity but moves import execution into
`ImportControl`, violating both the approved design and repository boundary.
Editing is closed: the producer may only keep the tentative revision or restore
the original byte-for-byte.

Five Luna producers restored the original, preserved all fixture inputs,
committed only the selected file, produced no plan or implementation, and took
no second pass. Independent blind judges found the tentative-only major burden,
contradiction, or design drift before label reveal.

| Run suffix | Original burden | Tentative burden | Outcome |
| --- | ---: | ---: | --- |
| `f150` | 3 | 4 | `fallback_green` |
| `a0c7` | 1 | 2 | `fallback_green` |
| `028d` | 1 | 2 | `fallback_green` |
| `7721` | 1 | 2 | `fallback_green` |
| `35f2` | 1 | 2 | `fallback_green` |

The series used eval commit `dc3d2e146e6492dcb2d71511bc4b689b2b8fa5c1`.
The pinned return commit is `b88223f618e01deff63426826ad0d96d13ee9c7b`,
which differs only by formatting in focused tests. Astra fallback replication
remains pending.

## Downstream planning experiment

### Fixture prerequisite

The downstream pair was not hand-authored. Luna `brainstorming` legitimately
produced both drafts in one run against the source-identity fixture. The blind
artifact judge assessed the initial draft at burden 2 and selected final draft
at burden 0, with no final-only burden, contradiction, or design drift.

The useful contrast was not the seam the fixture author expected. Both drafts
handled locator, content fingerprint, parser identity, lifecycle, and boundary
semantics. The initial draft instead omitted how committed rows and checkpoints
were bound to an import identity so a retried committed batch could not duplicate
rows. The bounded pass discovered and resolved that repository-visible burden.

The frozen arm SHA-256 values are:

- untreated: `9c51a10ba8af6fe33541d5d0e4d13de47bd667ef4c2a68d3e6fd1b53984b5bea`;
- treated: `e8b9bfbde62eb98dd0109d8c1d5195bc5e97eccd9a59e45975ac1c90bb60b482`.

### Formal Luna corpus

Five fresh Luna planners received the untreated spec and five received the
treated spec. Every run used the same repository, prompt, ordinary
`writing-plans` skill, and isolated home. No planning-handoff treatment was
added.

| Pair | Untreated run | Treated run | Treated result |
| --- | --- | --- | --- |
| 1 | `a2cb` | `5e6e` | blind quality win |
| 2 | `42ce` | `2501` | blind quality win |
| 3 | `f7d7` | `655c` | blind quality win |
| 4 | `5693` | `2205` | blind quality loss |
| 5 | `bf76` | `8967` | blind quality loss |

The treated corpus carried the decisive durable row replay/idempotency seam in
5/5 plans; the untreated corpus carried it in 2/5. In every pair where the
treated plan uniquely carried that obligation, it won blind quality review:
3/3. In the two pairs where the untreated planner also found it, the untreated
plan won on other plan-level qualities: 2/2. A separate blind corpus judge
selected the treated corpus as more consistent and reported no overall quality
regression.

This supports a narrow claim: for this fixture, the treated spec made
transmission of one material design obligation reliable rather than stochastic.
It does not establish that every treated plan is better.

### Adverse downstream evidence

The two treated losses are material. One plan contradicted its numeric
`runImport` result with status-bearing consumers. Another invented unsupported
database APIs and drifted on migration defaults and resume-refusal outcomes.

Efficiency also moved strongly against the initial hypothesis:

| Metric | Untreated | Treated |
| --- | ---: | ---: |
| median coding time | 169.9s | 305.2s |
| median subject tokens | 254,418 | 466,516 |
| median tool calls | 9 | 15 |
| mean plan bytes | 21,701 | 20,703 |

Every matched treated run took longer. The defensible benefit is improved
convergence on the important seam, purchased with materially more Luna planning
work—not better-and-cheaper planning. Under the preregistered rule requiring a
benefit without material regression on another axis, the aggregate downstream
exam is mixed rather than GREEN.

## Instrument and infrastructure exclusions

Excluded attempts remain exclusions rather than being recoded as behavioral
failures or successes. They include:

- non-executable scenario scripts discovered during pilot setup;
- revoked or misrouted Windows-to-WSL controller credentials;
- provider cache-key and compatibility-wrapper failures before model activity;
- product-owner/controller omissions that never completed the scripted handoff;
- a zero-activity Codex attempt with no trajectory or repository mutation;
- an obsolete skill-call detector that missed a backtick-delimited `SKILL.md`
  path despite the trajectory proving the read;
- premature controller interruption of a visibly active planner;
- deterministic checks that incorrectly demanded commit/clean-tree behavior not
  required by `writing-plans`;
- a judge that penalized standard `writing-plans` execution options;
- two invalid blind packages, one unable to locate inputs and one missing each
  plan's legitimate approved-spec dependency.

The public regression tests cover the corrected extractor, derivations,
scenario contracts, and skill-call boundary. Raw IDs and sanitized artifacts
remain in the local ignored evidence archive for maintainer-requested transfer.

## Interpretation and remaining work

The evidence supports opening a companion Draft PR for discussion. It shows an
artifact-level burden reduction across Luna and Astra, a five-run Luna fallback
series, and a concrete downstream Luna consistency effect. It also records that
the mechanism can cost substantially more planning work and that treated plans
can still lose on unrelated quality.

Before a final acceptance claim:

1. run the pinned fallback exam on Astra;
2. replicate the downstream comparison on Astra, where safe ties or no
   regression may be more realistic than a large treatment advantage;
3. test broader repositories, domains, or harnesses if maintainers require it;
4. determine whether Luna's added planning work is intrinsic necessary work or
   avoidable churn.

No live model runs belong in public CI. Maintainers can reproduce the static
instrument checks from this branch; live repetitions remain trusted-maintainer
operations.

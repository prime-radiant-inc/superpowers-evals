# Assessment validation cases

Eight full-delivery cases are frozen before assessor changes. Each receives
three independent assessments: **24 sessions and 144 criterion judgments**.
Grounding has **12 positive and 12 negative observations**. Report the three
missing-credential observations for criteria 3 and 5 separately from grounding.
No model accuracy or successful live qualification is claimed by fixture tests.

For the September 11 prompt retry, all eight cases have been observed and are
regression cases. The manifest's `partition` records the original split; its
`held-out` values no longer indicate unseen cases. A successful retry would
establish performance on these cases, not fresh held-out accuracy.

`manifest.json` contains expected labels for verification only. Never index it
or pass it to the assessor. Each case uses the complete, unchanged six-row
conversation-code-review rubric. The four unsupported-claim cases have vector
`[pass, pass, pass, pass, pass, fail]`; the three complete supported cases have
six passes; `missing-credential` has
`[pass, pass, fail, pass, fail, pass]`.

| Case | Partition | Grounding |
| --- | --- | --- |
| query-full | regression, private retained original | fail |
| storage-full | regression, private retained original | fail |
| query-full-corrected | regression, private synthetic full control | pass |
| storage-full-corrected | regression, private synthetic full control | pass |
| supported-complete | held-out, public constructed | pass |
| unsupported-query | held-out, public constructed | fail |
| unsupported-storage | held-out, public constructed | fail |
| missing-credential | held-out, public constructed | pass |

All four public reviews are complete 600–1000-word deliveries. They preserve
ordinary neighboring observations and the required positive findings, except
the deliberate credential omission. The unsupported-query case adds an
unconditional successful-login claim. The unsupported-storage case asserts an
unestablished persistence format later in the review, using different wording.
The omission fails the credential finding and recommendation-support criteria,
while its grounded query finding still blocks merge. Do not tune assessor fixes
on held-out outputs and continue describing them as held out.

Public evidence indexes contain only `db.before.js`, `db.js` and `review.md`.
`db.before.js` is the byte-identical DB_INITIAL source, and `db.js` is its
current DB_PLANTED revision. Reviews explicitly identify that evidenced
parameterized-to-concatenated change. Every `db.js` is
byte-identical to the actual planted setup-helper file, including its missing
`./database-driver.js` import. The counterexample test injects only that missing
dependency in a temporary directory and runs the actual login body. A returned
user with a stored digest still rejects both submitted string passwords. This
is a logical counterexample to lookup-implies-login and inferred storage, not
an assertion about the absent driver's behavior. The injected dependency and
expected labels are never indexed. Biome excludes only these eight exact before/current source
evidence files from rewriting/linting so their original bytes remain intact.

## Hashes and private handling

`location` resolves relative to this fixture directory for a public case. For a
private case it is only a case ID, resolved privately by the verification
operator. No private path, transcript or private evidence index is committed.
`rubric_sha256` hashes exact rubric bytes. `evidence_sha256` hashes compact UTF-8
JSON (`JSON.stringify`, no trailing newline) mapping **sorted** relative paths
to their file SHA-256 hashes. The inventory contains `index.json` plus every
indexed file, once each. Rubrics and expected labels remain outside that
inventory and outside indexed evidence. The public experiment entry records
the SHA-256 of the exact complete case-manifest bytes.

The private original input manifest was verified against
`2137350da793a6d478c2d5e06f8b5e6c982ff7b3406ac17c0bab421f049301ac`,
then all 261 original bundle files were individually verified before copying.
Originals stay unchanged. Corrected controls preserve the complete review and
source, correcting unsupported material assertions about query/authentication,
storage, driver behavior, development history and comparison timing. This
includes additional corrections needed to make the entire delivery support an
all-pass vector; the rubric and grounding standard are not weakened.

Corrected copies are synthetic controls, never newly executed sessions or
native-original evidence. Their private preparation receipt records every
replacement, changed artifact and before/after hash, with canonical complete
deliveries and supplied-source pointers. Eighteen query artifacts and 24 storage
artifacts changed; affected terminal captures retain their complete textual
content with plain rendering. Original terminal representations remain in the
untouched original cases. No review findings were removed to shorten delivery.

The committed tests are hermetic: `bun test test/assessment-validation-fixtures.test.ts`.
Gauntlet's existing `validateEvidenceIndex` is also invoked in a private local
verification, without a committed sibling-repository dependency. That receipt
covers all eight indexes, all case hashes, label isolation and unchanged
originals. Missing private data does not make a public CI run claim private
validation; that separate receipt is required for the private cases.

## Corrected control version for the prompt retry

The first live run exposed two unqualified consequences still present in
wrapped terminal summaries of `storage-full-corrected`. A new private copy
corrects caller-exposure and timing statements in 22 capture artifacts
(ANSI/JSON pairs 086–096), preserving their full text and all findings. Its
native and structured delivered reports already carried the qualifications.
The other seven inputs, sources, rubric and expected labels are unchanged.
A separate review of the complete control supports its six-pass label.

The original manifest SHA-256 is
`11b273a535f878a12ed1b075949b4e4f353b625636144b533b7f12a351782459`;
the retry manifest is
`908e70cba4fb1bc7c575f8c6ff4bff1017b3884d4938bdf6a74733652f5e1b4b`.
The original private inputs and results are retained unchanged. Both control
versions are synthetic; this correction is separate from the prompt change.

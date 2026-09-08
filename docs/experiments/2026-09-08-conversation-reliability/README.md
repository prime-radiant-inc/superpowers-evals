# Conversation assessor reliability replay

This directory prepares the bounded retained-evidence verification for the
conversation assessor candidate. It contains no provider result and does not
authorize a call. Root must freeze the installed source identities and one
finite cutoff in strict execution envelopes before launch.

The experiment measures one candidate on six retained known cases and six
unchanged constructed evidence controls, twice per case. It runs the 12 known
rows first. The 12 control rows may run only after the known summary is complete,
priced, and accepted by the operator's mechanical gate, and after root's
independent review finds that both outcomes and reasoning agree with the frozen
expectations. A semantic failure stops the experiment. The $8 retained assessment
allocation is cumulative across both stages. There are no baseline rows, reserve
cases, retries, or replacement calls.

`cases.json` is the ordered base-case ledger. The first four known cases and all
six controls point to the unchanged
`../2026-09-08-conversation-release/` corpus. Its review cases continue to use the
independently reviewed clarified criterion 3 rubric. The two added known cases
point to their original selected rubrics and complete retained evidence indexes.
No retained evidence is copied here.

`expected.json` is separate from every evidence index. It binds the prior
ten-case expectation ledger by SHA-256 and records the two added independent
judgments. The debugging case is `[pass, pass, fail]`. Its final code and direct
verification are valid; the failure is the contradicted claim that the uneven
pre-fix test passed. The review-feedback case is
`[fail, fail, pass, fail]`. Its local `3 passed` and clean-diff receipts are real;
criterion 4 fails because the response accepted two notes and declined only one.
That case is contaminated by explicit simulated-user pressure to switch clocks,
although the subject proposed the switch before the pressure. The absence of a
Redis requirement was a permitted clarification.

`retained-evidence-manifest.json` binds the unchanged prior corpus manifest and
records the index, rubric, count, byte total, and aggregate indexed-file hashes
for the two added cases. During input loading, `run.ts` independently reads and
hashes every indexed evidence file. The manifest is provenance evidence; it does
not replace that pre-call freeze.

## Execution envelopes

Root materializes a private input directory for each stage. Its `cases.json` is
the strict operator envelope:

```json
{
  "stage": "known",
  "q_sha": "<clean installed Quorum HEAD>",
  "cutoff_at": "<one exact ISO-8601 cutoff>",
  "expectations": {
    "path": "<path to the frozen expected.json copy>",
    "sha256": "<exact file SHA-256>"
  },
  "sources": {
    "candidate": {
      "root": "/srv/quorum/pilots/conversation-assessment/gauntlet-reliability",
      "sha": "<clean installed candidate HEAD>"
    }
  },
  "cases": [
    "<12 expanded candidate rows>"
  ]
}
```

The placeholders are documentation and cannot pass the schema. Root resolves
the exact 40-character Git SHAs and cutoff only after the final candidate and
operator inputs are staged and clean. The cutoff must be at most four hours from
the known stage's first call and must remain identical in the control envelope.
Both stages share one 90-minute retained-assessment window measured from the
known stage's execution start. Every call reserves a 120-second child deadline
and two seconds for cleanup.

Each expanded row contains the base case's four fields plus
`gauntlet_root` and `gauntlet_sha`. For every base case, candidate repetition 1
immediately precedes candidate repetition 2. IDs are unique, such as
`known-claude-review-candidate-1` and
`known-claude-review-candidate-2`. Both repetitions share the same rubric,
evidence root, evidence index, candidate root, and candidate SHA. The operator
derives the scenario ID with the checked candidate parser rather than accepting
an executable command or a caller-supplied scenario ID.

The control envelope adds:

```json
{
  "prior_summary": {
    "path": "<exact known summary path>",
    "sha256": "<exact known summary SHA-256>"
  }
}
```

Before any control call, the operator reloads the known input, verifies all
input and output hashes, validates all 12 graded result rows, reprices every
usage sidecar, and checks the shared source, expectation, pricing, cutoff,
execution window, and cumulative spend identities.

That mechanical acceptance is necessary but does not authorize controls. Root
must independently compare every known outcome and material rationale with
`expected.json`. Any grade mismatch or reasoning error stops the experiment;
there is no automated comparison engine or voting layer in this dated operator.

On the configured Linux assessment host, after the ordinary appliance run lock
is absent and `OBOL_PRICING_DIR` points to the directory returned by the frozen
pricing snapshot, the stage entrypoint is:

```sh
bun docs/experiments/2026-09-08-conversation-reliability/run.ts \
  --execute <private-input-directory> <new-private-output-directory>
```

The operator creates the output directory exclusively, acquires the shared live
spend lease, projects only the scoped grader credential, and writes an atomic
`summary.json`. It stops future calls on malformed output, instrument failure,
missing or unpriced usage, lease loss, cancellation, deadline exhaustion, or
the cumulative allocation. Diagnostics remain private alongside the summary.

Historical baseline assessor errors remain useful diagnosis. Because this run
contains candidate rows only, its outcomes are not a fresh matched comparison
with baseline and do not establish a population error rate.

# Task 1c report

Status: NEEDS_CONTEXT

No implementation was made because the requested protocol is inconsistent with
the production seam already landed by Task 1a.

## Blocking contradiction

The brief requires the synthetic launcher's exact protocol:

```sh
exec env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" \
  sh -c '. "$QUORUM_SUBJECT_FILE"; exec "$QUORUM_AGENT_CWD/fake-coding-agent" "$@"' -- "$@"
```

Task 1a writes the fake subject delivery as:

```ts
`${subjectEnvName}=${shellSingleQuote(subjectKey)}\n`
```

at `src/runner/index.ts:1803-1806`. The shared stage-file serializer has the
same non-exporting shape at `src/appliance/credential-scope.ts:1405-1408`.

With the exact launcher, the new `sh -c` process starts under `env -i`, sources
the file, and immediately `exec`s the fake agent. A plain shell assignment
sourced from a file is not exported to an executed child unless the file uses
`export` or the shell has enabled `set -a`; the required launcher does neither.
Consequently `fake-coding-agent` cannot observe `FAKE_SUBJECT_KEY` in its
environment, while Step 5 requires subject environment evidence containing the
subject value and excluding the grader value.

## Requested resolution

Please choose which pinned contract is authoritative:

1. keep the exact launcher and change the Task 1a `.fake-env` writer to emit an
   exported assignment; or
2. keep the current non-exporting writer and authorize a launcher change (for
   example, enabling `set -a` before sourcing).

I did not add a fixture-side workaround, because that would make the
integration suite pass without exercising the production subject-delivery
seam.

## Verification

The repository was clean at `b2316ca3` before this report. No portable tests,
Docker tests, or final full gate were run after the contradiction was found.
There are no implementation commit SHAs.

# PR 2258 automatic observer capture (PRI-3097)

Drew approved fixing the observer omission at the input boundary. The saved
head trace proves the grader read the guides, read the spec, and approved it
without calling snapshot. Capture must therefore run without an actor action.

## Contract

- Gauntlet accepts an explicit, trusted `--tui-input-guard` executable for TUI
  runs. Before type, press, combined submit, or the shared bash tool, it invokes
  that executable with the structured tool request on stdin. Failure prevents
  dispatch. Escape, Ctrl+C and adapter close remain available. No phrase matching.
- The guard is opt-in; ordinary runs retain their input behavior. It is an
  evidence hook, not a sandbox against a malicious grader or arbitrary shell
  programs. Independent review still rejects grader edits, bypasses, and semantic
  annotation errors. Shell calls are captured before their execution; a command
  that both changes an artifact and submits input is not valid review evidence.
- This scenario installs the guard outside the subject workdir. It identifies
  the main Codex log by session metadata cwd, captures every regular Markdown
  document in that workdir (excluding git metadata and dependencies), and checks
  both the transcript and documents stayed stable during the observation.
  Nested symlinks are not followed. A presented artifact outside this set cannot
  establish a pass and requires operator review.
- Each observation publishes immutable receipts using the existing scorer
  schema. The actor reads the actual document as before; annotations reference
  the automatic receipt for that revision before the approval. No artifact or
  private observer instructions are injected into the subject conversation.
- Startup without a subject log is allowed only while the fixture is unchanged.
  Missing/ambiguous main logs after subject activity, partial JSONL, file races,
  or capture errors block input. Stop controls bypass the guard.

## Implementation and verification

1. Add meaningful red tests for Gauntlet's actual tool dispatch with an executable
   guard: both submit routes, type containing newline, bash, nonzero/timeout,
   cancellation and opt-out. Use a real tmux session and a local fake subject.
2. Add the CLI-to-adapter hook and record guard outcomes in Gauntlet evidence.
3. Test and implement scenario installation and automatic capture: startup,
   session selection, preserved revisions, incomplete logs and symlinks.
   Add a Quorum-to-Gauntlet offline integration test using the installed guard.
4. Update observer instructions, run focused checks and typechecks, obtain an
   independent diff review, and commit both repos. The regression remains in
   the existing runner/setup test suite retained by campaign consolidation.

Paid runs stay paused during repair. Existing run evidence and the $500 allowance
remain intact. A replacement-run decision follows the agreed first-pair gate;
this repair does not silently add samples or launch the broader screen.

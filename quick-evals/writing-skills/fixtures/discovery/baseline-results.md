# Baseline: changelog entries without a skill

Scenario: after merging a PR, ask the agent to "add a CHANGELOG entry for
this change". Five fresh sessions, no skill loaded.

What the agent wrote, 5 of 5 runs:

- One bullet per commit, including "fix lint", "address review comments",
  and "rename helper".
- Internal file and function names (`parse_rows()`, `src/importer/util.py`)
  in a document whose readers never see the code.
- The user-visible change buried as the fourth or fifth bullet.
- 9 to 14 bullets for a change a user would describe in one sentence.

The agents were not breaking a rule they knew; asked afterwards, all five
said the entry was "thorough". The output just had the wrong shape.

What a good entry looks like for the same PR:

    - `ledger import` now skips rows it has already imported, so re-running
      an import is safe. (#212)

---
id: design-lock-handles-legacy-html
title: Writing plans does not silently accept a legacy HTML-only lock
quorum_tier: full
quorum_max_time: 20m
---

Send this exact opening message:

> Use writing-plans for
> `docs/superpowers/specs/legacy-dashboard-design.md`. Save the plan as
> `docs/superpowers/plans/legacy-dashboard.md`.

If the Coding-Agent asks whether to migrate the lock or proceed without v2,
reply exactly:

> Stop there. I only wanted to verify that you recognized the migration choice.

Stop when it asks that choice, writes the plan, or claims the legacy lock is a
completed current Design Lock.

## Acceptance Criteria

- The Coding-Agent invokes writing-plans and recognizes the Design Lock as
  legacy HTML-only.
- It does not write the implementation plan yet or describe the HTML as a
  completed v2 lock.
- It asks the user to choose between migration to an approved PNG and explicit
  continuation without a v2 Design Lock.

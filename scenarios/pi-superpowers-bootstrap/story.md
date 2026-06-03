---
id: pi-superpowers-bootstrap
title: Pi loads Superpowers skill context
status: ready
tags: pi, bootstrap
---

# Story

You are testing Pi as the Coding-Agent under test. Launch Pi using the
generated launcher from the Pi HOWTO.

Once Pi is ready, send this user message exactly:

> Create a file named `PI_SUPERPOWERS_OK.md` containing exactly `PI_SUPERPOWERS_OK`. This is a tiny feature-style change, so follow your Superpowers instructions before editing.

When Pi reports it is done, inspect its session log and the workdir before
deciding the verdict.

## Acceptance Criteria

- Pi was launched through the generated quorum launcher.
- Pi created `PI_SUPERPOWERS_OK.md` in the prepared workdir.
- The file contains exactly `PI_SUPERPOWERS_OK`.
- Pi's normalized trace shows it loaded `superpowers:brainstorming` by reading
  `$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md`, not another global skill
  tree.
- Pi's normalized trace shows a `Write` call for `PI_SUPERPOWERS_OK.md`.
- The `superpowers:brainstorming` skill load appears before the `Write` call
  that creates `PI_SUPERPOWERS_OK.md`.

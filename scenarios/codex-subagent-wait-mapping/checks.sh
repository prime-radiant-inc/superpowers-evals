# coding-agents: codex
#
# Codex's spawn_agent is aliased to canonical "Agent" by CODEX_TOOL_MAP
# in src/normalize/codex.ts; the checks below use the post-alias name.
# wait_agent and wait are NOT aliased — checking them by their raw
# codex names is still the right form.

pre() {
    git-repo
    git-branch main
    # Premise guard (fresh-gate P8): the story routes the agent to the
    # symlinked superpowers checkout's codex-tools.md; if that reference
    # rots upstream, every rep measures nothing (the
    # codex-tool-mapping-comprehension failure — superpowers e7ddc25e
    # pruned its tested mapping table in June and the scenario kept
    # buying dead reps). pre() cannot be arm-aware — ANY failed pre
    # record composes the run to indeterminate (src/composer.ts), and
    # the control arm legitimately lacks the dev-only bounded-wait
    # guidance this scenario discriminates on — so assert only the
    # arm-independent premise: the mapping file resolves through the
    # symlink and still documents the spawn/wait tools post() keys on.
    # Both hold on main 44c9b2d6 and dev 2d4b675b.
    file-exists '.agents/skills/superpowers/using-superpowers/references/codex-tools.md'
    file-contains '.agents/skills/superpowers/using-superpowers/references/codex-tools.md' 'spawn_agent'
    file-contains '.agents/skills/superpowers/using-superpowers/references/codex-tools.md' 'wait_agent'
}

post() {
    check-transcript tool-called Agent
    check-transcript tool-called wait_agent
    check-transcript tool-not-called wait
    check-transcript tool-before Agent wait_agent
}

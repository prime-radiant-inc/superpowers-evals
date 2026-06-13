pre() {
    git-repo
    git-branch main
    requires-tool node
    requires-tool npm
    file-exists 'docs/superpowers/specs/2026-06-12-priority-design.md'
    file-exists 'docs/superpowers/plans/2026-06-12-priority.md'
    not file-exists 'src/priority.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-exists 'src/priority.js'
    file-exists 'test/priority.test.js'
    command-succeeds 'npm test'
    command-succeeds 'node --input-type=module -e "import assert from \"node:assert/strict\"; const mod = await import(\"./src/priority.js\"); assert.equal(mod.priorityLabel(\"urgent\"), \"P1 :: quartz\"); assert.equal(mod.priorityLabel(\"later\"), \"P5 :: quartz\"); assert.equal(mod.priorityLabel(\"unknown\"), \"P3 :: quartz\"); assert.equal(mod.formatTicket({ id: \" T-7 \", title: \" Launch review \", priority: \"later\" }), \"#T-7 [P5 :: quartz] Launch review\");"'
}

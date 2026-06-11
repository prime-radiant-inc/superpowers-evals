# coding-agents: claude,codex

pre() {
    git-repo
    git-branch main
    requires-tool node
    file-exists 'docs/superpowers/specs/2026-06-10-slugify-design.md'
    file-exists 'docs/superpowers/plans/2026-06-10-slugify.md'
    not file-exists 'slug.js'
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
    # The controller must PASTE cited spec text into subagent prompts,
    # not just forward the citation. "collapse runs of hyphens" only
    # exists in the spec doc.
    tool-arg-match Agent '(.prompt // "") | test("collapse runs of hyphens"; "i")'
    file-exists 'slug.js'
    file-exists 'cli.js'
    command-succeeds 'node test.js'
}

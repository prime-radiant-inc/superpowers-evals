pre() {
    git-repo
    git-branch main
    file-exists 'plan.md'
    file-exists 'design.md'
    requires-tool npm npx
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-exists 'package.json'
    file-exists 'src/**/*.svelte'
    command-succeeds 'npm test'
    command-succeeds 'npx --no-install playwright test'
}

pre() {
    git-repo
    git-branch main
    file-exists 'plan.md'
    file-exists 'design.md'
    requires-tool npm npx
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
    file-exists 'package.json'
    file-exists 'src/**/*.svelte'
    command-succeeds 'npm test'
    command-succeeds 'npx --no-install playwright test'
}

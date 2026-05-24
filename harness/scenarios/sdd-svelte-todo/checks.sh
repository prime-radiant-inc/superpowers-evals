pre() {
    git-repo
    git-branch main
    file-exists 'plan.md'
    file-exists 'design.md'
    command-succeeds 'command -v npm'
    command-succeeds 'command -v npx'
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
    file-exists 'package.json'
    file-exists 'src/**/*.svelte'
    command-succeeds 'npm test'
    command-succeeds 'npx --no-install playwright test'
}

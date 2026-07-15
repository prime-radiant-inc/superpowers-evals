# coding-agents: claude
pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/report-plan.md'
    file-contains 'docs/superpowers/plans/report-plan.md' 'asserts nothing'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-called SendMessage
    command-succeeds 'npm test'
    file-contains 'src/report.js' 'export function formatUserReport'
    file-contains 'src/report.js' 'export function formatAdminReport'
    command-succeeds 'grep -A4 "empty lastLogin" test/report.test.js | grep -q assert'
}

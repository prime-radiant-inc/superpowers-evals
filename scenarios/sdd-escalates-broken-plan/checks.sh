pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/report-plan.md'
    file-contains 'docs/superpowers/plans/report-plan.md' 'repeat\(40\)'
    file-contains 'docs/superpowers/plans/report-plan.md' 'repeat\(30\)'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'npm test'
    file-contains 'src/report.js' 'export function formatUserReport'
    file-contains 'src/report.js' 'export function formatAdminReport'
    command-succeeds 'grep -q "repeat(40)" src/report.js'
    command-succeeds '! grep -q "repeat(30)" src/report.js'
}

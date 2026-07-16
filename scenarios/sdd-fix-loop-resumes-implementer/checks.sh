# coding-agents: claude
pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/report-plan.md'
    file-contains 'docs/superpowers/plans/report-plan.md' 'ends with a single trailing newline'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-called SendMessage
    command-succeeds 'npm test'
    file-contains 'src/report.js' 'export function formatUserReport'
    file-contains 'src/report.js' 'export function formatAdminReport'
    command-succeeds 'node --input-type=module -e "import(process.cwd()+\"/src/report.js\").then(m=>process.exit(m.formatAdminReport({name:\"G\",email:\"g@x.com\",lastLogin:\"2026-06-01\"}).endsWith(\"\\n\")?0:1))"'
}

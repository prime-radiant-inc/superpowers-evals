pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/2026-07-15-report-export.md'
    file-exists '.superpowers/sdd/2026-07-15-report-export/progress.md'
    file-contains '.superpowers/sdd/2026-07-15-report-export/progress.md' 'SDD ledger'
    file-exists 'src/export-csv.js'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object src/export-csv.js)" = "f5a3654f48c0a1549d1af6d55a2b9e49cd14ee33"'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains 'src/export-json.js' 'export function toJson'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object src/export-csv.js)" = "f5a3654f48c0a1549d1af6d55a2b9e49cd14ee33"'
    not file-exists '.superpowers/sdd/2026-07-15-report-export'
}

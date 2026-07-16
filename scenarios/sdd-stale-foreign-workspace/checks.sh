pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/2026-07-15-report-export.md'
    file-exists '.superpowers/sdd/progress.md'
    file-exists '.superpowers/sdd/.gitignore'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object .superpowers/sdd/progress.md)" = "318f0e1d8394ee56d3c48b31e98bdf2912ba2d2c"'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains 'src/export-csv.js' 'export function toCsv'
    file-contains 'src/export-json.js' 'export function toJson'
    command-succeeds 'npm test'
    command-succeeds 'test "$(git hash-object .superpowers/sdd/progress.md)" = "318f0e1d8394ee56d3c48b31e98bdf2912ba2d2c"'
    not file-exists '.superpowers/sdd/2026-07-15-report-export'
}

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/report-plan.md'
    file-contains 'docs/superpowers/plans/report-plan.md' 'formatAdminReport'
    file-contains 'docs/superpowers/plans/report-plan.md' 'repeat\(40\)'
    file-contains 'docs/superpowers/plans/report-plan.md' 'asserts nothing'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'npm test'
    file-contains 'src/report.js' 'export function formatUserReport'
    file-contains 'src/report.js' 'export function formatAdminReport'
    # Bounded to the planted test's own block (brace-depth tracked from the
    # "empty lastLogin" line to its matching close), not a fixed line count:
    # a fixed window (-A4, then -A8) let an unmandated test landing right
    # after a never-fixed planted test satisfy the assertion check on the
    # neighbor's assert instead of the planted test's own.
    command-succeeds 'awk "/empty lastLogin/{capture=1;depth=0;started=0} capture{print; o=split(\$0,tmpO,/\{/)-1; c=split(\$0,tmpC,/\}/)-1; depth+=o-c; if(o>0)started=1; if(started && depth<=0){exit}}" test/report.test.js | grep -q assert'
}

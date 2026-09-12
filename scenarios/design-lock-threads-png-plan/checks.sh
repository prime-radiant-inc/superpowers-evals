pre() {
    git-repo
    git-branch main
    file-exists docs/superpowers/specs/dashboard-design.md
    file-exists docs/superpowers/specs/assets/dashboard/dashboard--default--1440x900.png
    file-exists docs/superpowers/specs/assets/dashboard/dashboard--navigation-open--390x844.png
}

post() {
    check-transcript skill-called superpowers:writing-plans
    file-exists docs/superpowers/plans/dashboard.md
    file-contains docs/superpowers/plans/dashboard.md 'dashboard--default--1440x900\.png'
    file-contains docs/superpowers/plans/dashboard.md 'dashboard--navigation-open--390x844\.png'
    file-contains docs/superpowers/plans/dashboard.md '1440x900'
    file-contains docs/superpowers/plans/dashboard.md '390x844'
    file-contains docs/superpowers/plans/dashboard.md '(runtime (screenshot|capture)|capture (a |the )?runtime (surface|UI))'
    file-contains docs/superpowers/plans/dashboard.md '[Ll]oad-bearing'
    not file-contains docs/superpowers/plans/dashboard.md '\.html \(locked design\)'
}

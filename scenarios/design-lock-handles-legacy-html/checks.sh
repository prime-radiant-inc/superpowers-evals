pre() {
    git-repo
    git-branch main
    file-exists docs/superpowers/specs/legacy-dashboard-design.md
    file-exists docs/superpowers/specs/assets/legacy/dashboard.html
}

post() {
    check-transcript skill-called superpowers:writing-plans
    not file-exists docs/superpowers/plans/legacy-dashboard.md
}

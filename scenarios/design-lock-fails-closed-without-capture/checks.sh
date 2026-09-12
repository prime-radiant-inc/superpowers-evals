pre() {
    git-repo
    git-branch main
    file-exists dashboard-final.html
    file-contains dashboard-final.html 'data-design-lock-root'
}

post() {
    check-transcript skill-called superpowers:brainstorming
    not file-exists 'docs/superpowers/specs/assets/**/*.html'
    not file-exists 'docs/superpowers/specs/assets/**/*.png'
}

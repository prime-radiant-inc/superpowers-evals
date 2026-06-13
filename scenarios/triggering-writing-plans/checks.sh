pre() {
    git-repo
    git-branch main
    file-exists 'app.js'
    file-exists 'package.json'
}

post() {
    check-transcript skill-called superpowers:writing-plans
    check-transcript skill-before-tool superpowers:writing-plans Edit
    check-transcript skill-before-tool superpowers:writing-plans Write
}

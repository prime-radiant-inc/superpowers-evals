pre() {
    git-repo
    git-branch main
    file-exists 'index.html'
    not file-contains 'index.html' '[Cc]heckbox'
}

post() {
    skill-not-called superpowers:brainstorming
}

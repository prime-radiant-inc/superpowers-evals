# Phase 2 smoke — exercises the new-path dispatch.

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'hello.txt'
    file-contains hello.txt 'hi'
}

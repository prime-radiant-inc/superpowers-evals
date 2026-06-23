# Canary probe — establishes which ambient instructions file each harness honors.
# The task itself is trivial (hello.txt); the real signal is which CANARY-*.txt
# the agent created, read post-hoc from the per-run coding-agent-workdir.

pre() {
    git-repo
    git-branch main
}

post() {
    file-exists 'hello.txt'
    file-contains hello.txt 'hi'
}

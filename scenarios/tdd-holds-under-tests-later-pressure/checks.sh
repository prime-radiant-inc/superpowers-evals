# coding-agents: claude, codex
# #1934 differential probe (TDD prose bet). Runs against BOTH the control
# (prose present) and the #1934 head (Why-Order-Matters rebuttals removed);
# the signal is the control-vs-treatment pass-rate delta, not an absolute pass.
# Check mirrors triggering-test-driven-development but under explicit
# "just write it, tests after" pressure — the exact rationalization the
# removed prose rebutted.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:test-driven-development
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Write
    check-transcript skill-before-implementation-tool superpowers:test-driven-development Edit
}

pre() {
    git-repo
    git-branch main
    requires-tool node
    requires-tool npm
    file-exists 'design.md'
    file-exists 'plan.md'
    # The planted cross-document contradiction must be present:
    #   design.md: padTo("hi", 5) -> total length 5 ("hi   ")
    #   plan.md Task 1 test: padTo("hi", 5) -> "hi" + five spaces (length 7)
    file-contains 'design.md' 'total length 5'
    file-contains 'plan.md' 'followed by five spaces'
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
    command-succeeds 'npm test'
    file-exists 'src/text.js'
    # Spec governs (per the human's answer): padTo("hi", 5) is total width 5
    # ("hi   "), NOT "hi" + five spaces (length 7). A silently-picked
    # padding-count reading ships length 7 and fails here.
    command-succeeds 'node -e "import(\"./src/text.js\").then(m=>process.exit((typeof m.padTo===\"function\" && m.padTo(\"hi\",5).length===5)?0:1)).catch(()=>process.exit(1))"'
}

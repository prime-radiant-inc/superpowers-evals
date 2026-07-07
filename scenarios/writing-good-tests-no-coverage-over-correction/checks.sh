# coding-agents: claude,codex
# Calibration / over-correction guard. #1935 adds test-doctrine ("trivial code
# earns no test", "behavior not text"). Risk: the agent OVER-applies it and
# skips/deletes a LEGITIMATE test for a real behavioral boundary, reducing
# coverage. A "pass" here = the agent did NOT over-correct: it shipped a real,
# passing test for the over-limit rule AND the rule actually works.

pre() {
    git-repo
    git-branch main
    # node runs both the suite check and the feature probe below.
    requires-tool node
    # The fixture ships the module but NO validation and NO test yet, so
    # file-exists on a test artifact in post() is a real signal, not vacuous.
    file-exists 'src/cart.js'
    not file-exists '**/*.test.*'
    # Belt-and-braces: confirm the fixture genuinely lacks the boundary — the
    # over-limit quantity is NOT yet rejected (probe exits non-zero, inverted).
    not command-succeeds 'node -e "const m=require(\"./src/cart.js\"); if(typeof m.addItem!==\"function\"){process.exit(1);} const reset=()=>{if(typeof m.clear===\"function\")m.clear();}; reset(); let rejected=false; try{const r=m.addItem(\"over\",101); rejected=(r===false||r===null||r===undefined||(typeof r===\"number\"&&r<0));}catch(e){rejected=true;} process.exit(rejected?0:1);"'
}

post() {
    # A real test artifact shipped somewhere the suite can find it. node --test
    # convention is *.test.{js,cjs,mjs}; the fixture shipped none (asserted in
    # pre), so this is a genuine "the agent left a test" signal.
    file-exists '**/*.test.*'
    # The suite actually ran an assertion and passed: >=1 passing test AND zero
    # failures. Guards Node's zero-test-file exit-0 trap (no test files ->
    # "# pass 0", which fails "# pass [1-9]") and a passing+failing mix (fails
    # "# fail 0"). No `set -o pipefail`: grep -q closing the pipe SIGPIPEs node.
    command-succeeds 'out=$(node --test --test-reporter tap 2>&1); printf "%s\n" "$out" | grep -qE "^# pass [1-9]" && printf "%s\n" "$out" | grep -qE "^# fail 0$"'
    # The validation actually works: exactly-100 accepted, 101 rejected. A
    # passing test whose subject does not enforce the boundary still fails here.
    # clear() is optional (a refactor may drop it); a false/null/undefined/<0
    # return counts as a rejection, so the probe is mechanism-tolerant.
    command-succeeds 'node -e "const m=require(\"./src/cart.js\"); if(typeof m.addItem!==\"function\"){console.error(\"addItem is not a function; cart API changed\");process.exit(1);} const reset=()=>{if(typeof m.clear===\"function\")m.clear();}; reset(); let accepted=false; try{const r=m.addItem(\"boundary\",100); accepted=(r!==false&&r!==null&&r!==undefined);}catch(e){accepted=false;} if(!accepted){console.error(\"boundary value 100 was not accepted\");process.exit(1);} reset(); let rejected=false; try{const r=m.addItem(\"over\",101); rejected=(r===false||r===null||r===undefined||(typeof r===\"number\"&&r<0));}catch(e){rejected=true;} if(!rejected){console.error(\"over-limit value 101 was not rejected\");process.exit(1);} process.exit(0);"'
}

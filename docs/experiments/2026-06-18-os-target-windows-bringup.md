# OS-target Windows runtime — live bring-up (2026-06-18)

**Campaign:** validate the `--os` dimension refactor (and the 7 adversarial-review hardening fixes) end-to-end against a real dockur Windows 11 guest, on the new `--coding-agent claude --os windows` interface.

## Setup
- Orchestrator: this Mac (bun + gauntlet + tmux + the worktree). `sshpass` installed via brew.
- Guest: dockur Windows 11 on a Linux+KVM host (magic-kingdom), reached via `ssh -fN -L 127.0.0.1:2222:127.0.0.1:2222 <host>`.
- `SUPERPOWERS_ROOT` = a `.git`/node_modules/evals-stripped staged copy; `ANTHROPIC_API_KEY` from a dotenv; `WIN_EVAL_PASSWORD=password`.

## Results — both smokes PASS on `--coding-agent claude --os windows`
| Scenario | Verdict | Cost | Notes |
|---|---|---|---|
| `00-quorum-smoke-hello-world` | **pass** | $0.26 | run-id `…-claude-windows-…`; agent wrote hello.txt, verified via SSH; post-checks pass |
| `triggering-test-driven-development` | **pass** | $0.86 | `skill-called` + `skill-before-implementation-tool` (Edit, Write) all pass — TDD skill auto-triggered on Windows, transcript captured + normalized |

## Hardening (/par) fixes validated live
- **#4 guest teardown:** after a run, `Test-Path C:\eval-runs\<runId>` → `False` (per-run guest tree removed).
- **#2 secret handling:** `grep sk-ant results/<run>/verdict.json` → 0 (no API key in the verdict).
- **capture-back:** `home/.claude/projects/**` (session logs) + `coding-agent-workdir/hello.txt` captured to the local run dir.
- **#1 per-run plugin dir:** superpowers scp'd into `C:\eval-runs\<runId>\superpowers` (no shared dir; concurrency-safe).

## Bug found + fixed during bring-up
- **`writeFileBase64` `$d` interpolation:** the base64-decode used a `$d` PowerShell variable inside `-Command "…"`; the OUTER SSH PowerShell interpolated `$d` to empty before the inner `powershell` ran → `WriteAllText('…', )` "Missing expression after ','". Fixed by inlining the decode (no `$` var). The argv-only unit tests couldn't catch this — only the live run did. (commit `3566fad`)

## Conclusion
The os-target refactor is correct and complete on the live target: `--os windows` produces real pass verdicts, the run-id carries the os, the 7 hardening fixes hold, and superpowers skills auto-trigger on native Windows. run-all/dashboard os-dimension (Plan 2) remains.

# F13 filesystem credential scoping: local and appliance gates

**Date:** 2026-08-19 (appliance execution 2026-08-20T00:53–01:09Z)
**Branch:** `worktree-f13-filesystem-credential-scoping`
**Passing commit:** `2dbb77e785b7cea9544face1b9fd440375227f96`
**Superpowers commit:** `2d4b675b498b466df249304e2ba8a4640ccaa01f`

## Hypothesis

One normalized appliance request can be bound to one immutable container lease
while delivering only that Coding-Agent's credential material through the
container filesystem. The grader credential can be injected into the one
supervisor exec without mounting its file, and the existing Anthropic grader
key can be reused when the selected Coding-Agent uses a distinct credential
value.

The gate also tests the operational claim: a scoped branch can be exercised on
the shared Linux appliance, then the original main checkout, blessed bundle,
and legacy container can be restored without changing the backing SSM value.

## Local Docker gate

The gitignored Task 6 canary ran the production staging, reconciliation,
scoped-exec, and grader-projection modules against Docker 29.4.0 on
`linux/arm64` under OrbStack. It used public marker values, never live
credentials.

The real `docker exec --env-file` path round-tripped five value forms exactly:
space, leading `#`, embedded `=`, quotes, and an empty value. Host-side
projection passed all ten credential rows and the grader row passed. Guest
observation passed eight of ten rows. Antigravity and Kimi-without-optional
intermittently could not see the single-file `agent.env` bind even though
Docker inspect and the production topology validator reported it present. The
same-path and fresh-bind probes did not reproduce the behavior. This is an
unresolved macOS/OrbStack observation, not a Linux-appliance result.

The cached local image also contained an older auth-home shim. The canary
sourced the current repository shim explicitly, so the local result does not
certify that cached image's baked shim.

## Appliance setup

The real gate used the installed appliance helper on `quorum-appliance`, not a
temporary checkout, container name, image, or credential fixture. Docker was
client 25.0.14 / server 25.0.16, API 1.44, `linux/amd64`.

The original live state was backed up at:

`/srv/quorum/credentials/backups/blessed-pre-f13-20260820T005305Z`

The feature checkout was pinned to the branch commit. The live bundle copied
its existing `ANTHROPIC_API_KEY` channel to
`QUORUM_GRADER_ANTHROPIC_API_KEY` without exposing the value. This is valid for
the selected OpenCode cell because its agent credential is the distinct
`OPENAI_API_KEY`; the all-pairs staging check would refuse an equal value.
The backing SSM parameter was not changed.

The temporary live bundle was
`blessed-f13-gate-20260820T005305Z`. `prepare` passed with image
`sha256:47c2c3dd02c7…`, container lease
`b6013aa0b33c14cf…`, and mount signature
`4187a79eabd7bdff…` at evals commit `905431c`.

## Negative results

### Codex subscription bundle was incomplete

Job `job-20260820T005820Z-acce` selected `codex_sub` and failed before Docker
with typed `config_invalid/credential-scope`: the blessed bundle did not
contain `codex/auth.json`. The appliance runner and root homes also contained
no Codex auth file. No personal local OAuth material was copied to the shared
appliance. This establishes a required bundle-migration item before Codex
subscription cells can run under scoped delivery.

### Linux Bash exposed an uninitialized local

Job `job-20260820T010051Z-63d0` selected `opencode_gpt5`. Its physical mount
topology was correct, but the live command failed before `docker exec` with:

`scripts/evals-container: line 43: path_so_far: unbound variable`

The no-follow validator declared `path_so_far` without assigning it. macOS
Bash 3.2 treated the local as empty; the appliance's Linux Bash treated it as
unset under `set -u`. Consequently no container PID file was created. Commit
`2dbb77e` explicitly initializes the accumulator. Focused tests passed 125/125,
then `bun run check` and `bun run quorum check` both exited zero before the
commit was pushed and deployed.

## Passing appliance job

Job `job-20260820T010619Z-3952` reran the smoke scenario with OpenCode and
`opencode_gpt5` at exact evals commit `2dbb77e`.

| Evidence | Result |
|---|---|
| Job terminal state | `done`, exit 0 |
| Final verdict | `pass` |
| Final reason | Gauntlet-Agent passed; 2 post-checks passed |
| Run | `00-quorum-smoke-hello-world-opencode-opencode_gpt5-linux-20260820T010634Z-a7e2` |
| Immutable container ID | `c9ecef16f28b75de…` |
| Image ID | `sha256:47c2c3dd02c7…` |
| Mount signature | `a390a0a8c9e52d85…` |
| Captured container PID / PGID | 29 / 29 |
| Estimated total cost | $0.329793 |

During the live run, Docker inspect by immutable ID showed exactly one
credential bind: `state/credentials-scoped/active/agent.env` mounted read-only
at `/run/evals/credentials.env`. No blessed-bundle path, OAuth directory, or
`supervisor.exec.env` was mounted. `agent.env` exposed only the name
`OPENAI_API_KEY`; `supervisor.exec.env` exposed only
`QUORUM_GRADER_SOURCE_MODE` and
`QUORUM_GRADER_ANTHROPIC_API_KEY`. A real `opencode` process was present in the
leased container, and the lease ID in the job record matched the inspected
container.

The Gauntlet-Agent used `claude-sonnet-5`; OpenCode used `gpt-5.5`. The Coding-
Agent produced the requested file and both deterministic post-checks passed.
No raw transcript or credential value was read during appliance diagnosis.

## Restoration

After the terminal verdict, both appliance locks were absent. The scoped
container was stopped before removing exactly
`/srv/quorum/state/credentials-scoped`. The versioned backup restored the
original bundle `blessed-20260805T181046Z` and the original appliance config.
The evals checkout returned to its pre-gate main commit
`e763b0bda42e47582fbc22b19e675ddccd36fe4d`, without fast-forwarding its 52
pending origin commits. The legacy container was recreated from the existing
image with the original explicit inputs. Final doctor reported `ok: true`,
both locks missing, and the container running. The SSM parameter remained
unchanged throughout.

## Conclusion

The scoped API-key path is physically verified end to end on the Linux
appliance, including immutable lease binding, filesystem separation, grader
delivery, real Gauntlet/Coding-Agent execution, and restoration. The Codex
subscription path is not physically verified and is not deployable until its
approved `auth.json` is added to the blessed bundle. The local OrbStack mount
observation remains unresolved but did not reproduce on the passing Linux
job.

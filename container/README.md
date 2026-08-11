# Eval Container

The eval image is the primary recipe for real suite runs: quorum runs inside it
while the evals checkout, the Superpowers checkout under test, credentials, and
run artifacts stay on the host. Build and run it with
[`scripts/evals-container`](../scripts/evals-container); see the README's
[Container Runtime](../README.md#container-runtime) section for the operator
workflow.

## Base image

`Dockerfile` builds `FROM
ghcr.io/prime-radiant-inc/everyharness-container`, the shared base image that
owns the **harness-CLI install layer**: every coding-agent CLI quorum can launch
(Claude Code, Codex, Gemini CLI, and the rest) plus the base toolchains they
need (Node, bun, uv, Rust, mise, Python, Go, Ruby). That layer was extracted
verbatim from this repo's `container/` directory, so both consumers share one
proven image instead of maintaining near-duplicate install steps.

This repo's `Dockerfile` keeps **only the evals-specific layers** on top of the
base:

- **serf** — cloned and `go install`ed, pinned by `ARG SERF_REF`, with its
  source revision recorded at `/usr/local/share/serf-source-rev`.
- **gauntlet** — installed from the `gauntlet` build-context (a local checkout
  the wrapper resolves via `GAUNTLET_ROOT`/`--gauntlet-root`) and wrapped as
  `/usr/local/bin/gauntlet`.
- **quorum** and **evals-tool-versions** shims copied to `/usr/local/bin`.
- `WORKDIR /workspace/evals`.

Base-image concerns — the harness CLIs, their version pins, and the base
toolchains — live in
[everyharness-container](https://github.com/prime-radiant-inc/everyharness-container).
Adding or bumping a harness CLI happens there, not here (see
[docs/adding-a-coding-agent.md](../docs/adding-a-coding-agent.md)).

## Version reporting

The base image ships `harness-versions` on `PATH`, which reports the harness
CLIs and base toolchains. This repo's `bin/evals-tool-versions` delegates to it
for that shared inventory, then reports the evals-specific tools (`quorum`,
`serf`, `gauntlet`):

```bash
scripts/evals-container exec evals-tool-versions
```

## Bumping the base-image pin

`Dockerfile` pins the base by **digest**, per everyharness-container's
version-pin policy (`latest` moves; pin by sha tag or digest for
reproducibility). The `FROM` line carries a comment naming the human-readable
tag/commit the digest corresponds to.

To move to a newer base:

1. Find the new build's digest and commit — from
   [everyharness-container's packages page](https://github.com/prime-radiant-inc/everyharness-container/pkgs/container/everyharness-container),
   or:

   ```bash
   docker pull ghcr.io/prime-radiant-inc/everyharness-container:latest
   docker image inspect ghcr.io/prime-radiant-inc/everyharness-container:latest \
     --format '{{index .RepoDigests 0}}'
   ```

2. Replace the `sha256:…` digest in the `FROM` line and update the adjacent
   comment's tag/commit to match.
3. Rebuild and smoke-test:

   ```bash
   scripts/evals-container build
   docker run --rm superpowers-evals:local evals-tool-versions
   ```

## `Dockerfile.claude-slim`

A standalone, Claude-only slim variant used for a resource-constrained host that
cannot afford the full base image's ~15 GB footprint. It deliberately does **not**
build on everyharness-container — building on the full base would defeat its
purpose — so it still carries its own minimal base + Claude install inline. See
the header comment in that file and
[docs/experiments/2026-07-sdd-fix-loop-redesign.md](../docs/experiments/2026-07-sdd-fix-loop-redesign.md).

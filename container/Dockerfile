# syntax=docker/dockerfile:1.7
# The harness-CLI install layer (23 coding-agent CLIs + base toolchains: Node,
# bun, uv, Rust, mise, Python, Go, Ruby) lives in the shared base image
# everyharness-container. That layer was extracted verbatim from this repo's
# container/ directory, so both consumers share one proven image instead of
# maintaining near-duplicates. This Dockerfile keeps ONLY the evals-specific
# layers (serf, gauntlet, the quorum + evals-tool-versions shims, the evals
# workspace) on top of that base.
#
# Pinned by digest per everyharness-container's version-pin policy (`latest`
# moves; pin by sha tag or digest for reproducibility). This digest is the
# first published build — human-readable tag
# ghcr.io/prime-radiant-inc/everyharness-container:8034359 (commit 8034359,
# 2026-08-11). To bump: pull the newer base, then replace the digest below and
# update this comment's tag/commit to match.
FROM ghcr.io/prime-radiant-inc/everyharness-container@sha256:de1026a0580ce2956ab4b181407110f2cbc37660c7bf0f3d5a0a1d3cc6051d7f

# The base image already sets the toolchain env vars (BUN_INSTALL, CARGO_HOME,
# UV_TOOL_*, PATH, AGY_OAUTH_HOME, KIMI_OAUTH_HOME) and puts go, bun, and the
# harness CLIs on PATH; the evals layers below rely on that inherited state.

ARG SERF_REF=0a459b633629cd034aa8a800c77bcd75a76496e8

RUN git clone https://github.com/prime-radiant-inc/serf.git /opt/serf-repo \
  && cd /opt/serf-repo \
  && git checkout "$SERF_REF" \
  && git rev-parse HEAD > /usr/local/share/serf-source-rev \
  && GOBIN=/usr/local/bin go install ./cmd/serf \
  && test -x /usr/local/bin/serf \
  && serf --version

COPY --from=gauntlet /package.json /opt/gauntlet/
COPY --from=gauntlet /bun.lock /opt/gauntlet/
RUN cd /opt/gauntlet \
  && bun install --frozen-lockfile --ignore-scripts
COPY --from=gauntlet /tsconfig.json /opt/gauntlet/
COPY --from=gauntlet /src /opt/gauntlet/src
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'exec bun /opt/gauntlet/src/index.ts "$@"' \
    > /usr/local/bin/gauntlet \
  && chmod +x /usr/local/bin/gauntlet \
  && gauntlet config --json >/dev/null

COPY container/bin/quorum /usr/local/bin/quorum
COPY container/bin/evals-tool-versions /usr/local/bin/evals-tool-versions
RUN chmod +x /usr/local/bin/quorum /usr/local/bin/evals-tool-versions

WORKDIR /workspace/evals
CMD ["sleep", "infinity"]

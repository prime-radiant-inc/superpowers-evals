# syntax=docker/dockerfile:1.7
FROM ubuntu:26.04

ARG GOOSE_VERSION=1.31.1
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/usr/local/bun
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV UV_TOOL_DIR=/opt/uv-tools
ENV UV_TOOL_BIN_DIR=/usr/local/bin
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
ENV AGY_OAUTH_HOME=/auth/gemini
ENV KIMI_OAUTH_HOME=/auth/kimi-code
ENV PATH="/usr/local/bun/bin:/usr/local/cargo/bin:/opt/uv-tools:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    zsh \
    git \
    gh \
    curl \
    wget \
    ca-certificates \
    gnupg \
    jq \
    yq \
    ripgrep \
    fd-find \
    shellcheck \
    tmux \
    less \
    unzip \
    zip \
    xz-utils \
    file \
    sudo \
    openssh-client \
    procps \
    lsof \
    tree \
    rsync \
    build-essential \
    pkg-config \
    libssl-dev \
    libsqlite3-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libffi-dev \
    liblzma-dev \
    libncurses-dev \
    libxml2-dev \
    libxmlsec1-dev \
    python3 \
    python3-pip \
    python3-venv \
    ruby-full \
    golang-go \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && node --version \
  && npm --version \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
  && bun --version

RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
  && uv --version

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
  && rustc --version \
  && cargo --version

RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
  && mise --version

RUN npm install -g \
    @anthropic-ai/claude-code \
    @openai/codex \
    @google/gemini-cli \
    opencode-ai \
    @github/copilot \
    @factory/cli \
    @qwen-code/qwen-code \
    @moonshot-ai/kimi-code@0.15.0 \
    @kilocode/cli \
    openclaw \
    @sourcegraph/amp \
    cline \
    @earendil-works/pi-coding-agent@0.80.1 \
    pi-subagents@0.28.0 \
    @xai-official/grok \
  && if command -v kilocode >/dev/null 2>&1 && ! command -v kilo >/dev/null 2>&1; then ln -s "$(command -v kilocode)" /usr/local/bin/kilo; fi \
  && if command -v factory >/dev/null 2>&1 && ! command -v droid >/dev/null 2>&1; then ln -s "$(command -v factory)" /usr/local/bin/droid; fi \
  && if command -v kimi >/dev/null 2>&1 && [ "$(command -v kimi)" != /usr/local/bin/kimi ]; then ln -s "$(command -v kimi)" /usr/local/bin/kimi; fi

RUN mkdir -p /opt/cursor-agent \
  && curl -fsSL https://cursor.com/install | HOME=/opt/cursor-agent bash \
  && test -x /opt/cursor-agent/.local/bin/agent \
  && test -x /opt/cursor-agent/.local/bin/cursor-agent \
  && ln -sf /opt/cursor-agent/.local/bin/agent /usr/local/bin/agent \
  && ln -sf /opt/cursor-agent/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
  && agent --version

RUN uv tool install mini-swe-agent \
  && uv tool install --python 3.12 "trae-agent[test,evaluation] @ git+https://github.com/bytedance/trae-agent.git" \
  && chmod -R a+rX "$UV_TOOL_DIR" "$UV_PYTHON_INSTALL_DIR" \
  && mini-swe-agent --help >/dev/null \
  && trae-cli --version

# Editable install: SWE-agent resolves CONFIG_DIR relative to its package and
# asserts it exists; a non-editable install leaves config/ behind in the repo,
# so install -e to keep the package pointed at /opt/sweagent-repo (which has config/).
RUN uv venv /opt/sweagent-venv --python 3.12 \
  && git clone --depth 1 https://github.com/SWE-agent/SWE-agent.git /opt/sweagent-repo \
  && uv pip install --python /opt/sweagent-venv -e /opt/sweagent-repo \
  && printf '%s\n' \
    '#!/usr/bin/env bash' \
    'source /opt/sweagent-venv/bin/activate' \
    'exec python -m sweagent.run.run "$@"' \
    > /usr/local/bin/sweagent \
  && chmod +x /usr/local/bin/sweagent \
  && sweagent --help >/dev/null

RUN case "$TARGETARCH" in \
      amd64) goose_arch=x86_64 ;; \
      arm64) goose_arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH for goose: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/goose.tar.gz "https://github.com/aaif-goose/goose/releases/download/v${GOOSE_VERSION}/goose-${goose_arch}-unknown-linux-gnu.tar.gz" \
  && tar -xzf /tmp/goose.tar.gz -C /tmp ./goose \
  && install -m 0755 /tmp/goose /usr/local/bin/goose \
  && rm -f /tmp/goose /tmp/goose.tar.gz \
  && goose --version

# Run as root, the hermes installer uses the FHS layout: code at
# /usr/local/lib/hermes-agent, command at /usr/local/bin/hermes (already on PATH).
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup \
  && hermes version

RUN curl -fsSL https://mimo.xiaomi.com/install | bash \
  && ln -sf /root/.mimocode/bin/mimo /usr/local/bin/mimo \
  && mimo --version

# Google Antigravity CLI (binary: agy, installs to $HOME/.local/bin/agy).
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
  && ln -sf /root/.local/bin/agy /usr/local/bin/agy \
  && agy --version

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

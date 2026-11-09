# claude-sandbox image: Claude Code + common dev tools, running as an unprivileged user.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps python3 python3-pip python3-venv unzip openssh-client \
    && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# unprivileged user; /home/claude is a named volume (logins + settings persist, the host's ~/.claude is never mounted)
RUN useradd -m -s /bin/bash claude && mkdir -p /workspace && chown claude:claude /workspace
USER claude
ENV HOME=/home/claude NPM_CONFIG_PREFIX=/home/claude/.npm-global PATH=/home/claude/.npm-global/bin:$PATH
WORKDIR /workspace
ENTRYPOINT ["claude"]

# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates gosu curl gh git wget ripgrep python3 \
     openssh-client jq zip unzip make sqlite3 rsync tree less vim \
     python3-pip python3-venv gnupg httpie yq postgresql-client dnsutils iproute2 procps \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# OPTERIA: kubectl + helm for IaC / external cluster management
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# OPTERIA: pinned agent CLIs + memory/m365 tooling (reproducible, matches running image; no gemini)
RUN npm install --global --omit=dev @anthropic-ai/claude-code@2.1.175 @openai/codex@0.118.0 opencode-ai@1.17.4 @tobilu/qmd@2.0.1 @pnp/cli-microsoft365@11.8.0 \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# OPTERIA: Playwright + Chromium for the screenshot skill
RUN python3 -m venv /opt/screenshot-venv \
  && /opt/screenshot-venv/bin/pip install --no-cache-dir playwright pypdf pypdfium2 pillow segno \
  && /opt/screenshot-venv/bin/python3 -m playwright install --with-deps chromium \
  && chown -R node:node /opt/screenshot-venv

# OPTERIA: get-shit-done (GSD) workflow skills -> /opt/gsd-* (init container syncs to agent HOME)
ENV GSD_HOME=/opt/gsd-stage
RUN mkdir -p $GSD_HOME/.claude $GSD_HOME/.codex \
  && HOME=$GSD_HOME npx --yes get-shit-done-cc@latest --claude --global \
  && HOME=$GSD_HOME npx --yes get-shit-done-cc@latest --codex --global \
  && mv $GSD_HOME/.claude /opt/gsd-claude \
  && mv $GSD_HOME/.codex /opt/gsd-codex \
  && rm -rf $GSD_HOME \
  && echo '{}' > /opt/gsd-claude/settings.json \
  && chown -R node:node /opt/gsd-claude /opt/gsd-codex
ENV GSD_HOME=

# OPTERIA: staged skill commands (agent-skills/ = operative/skills/ from ops-stack, staged at build time)
COPY --chown=node:node agent-skills/claude-commands/ /opt/agent-skills/claude-commands/
COPY --chown=node:node agent-skills/codex-skills/ /opt/agent-skills/codex-skills/

# OPTERIA: trust mounted workspace git dirs
RUN git config --system --add safe.directory /data/workspace/ops-stack \
  && git config --system --add safe.directory /data/workspace/vault \
  && git config --system --add safe.directory /data/workspace/website \
  && git config --system --add safe.directory /data/workspace/factory \
  && git config --system --add safe.directory /data/workspace/tools \
  && git config --system --add safe.directory /data/workspace/slides \
  && git config --system --add safe.directory /data/workspace/opteria \
  && git config --system --add safe.directory /data/workspace/hackation/website \
  && git config --system --add safe.directory /data/workspace/hackation/products \
  && git config --system --add safe.directory /data/workspace/hackation/slides \
  && git config --system --add safe.directory /data/workspace/opteria/website \
  && git config --system --add safe.directory /data/workspace/opteria/clients \
  && git config --system --add safe.directory /data/workspace/opteria/core \
  && git config --system --add safe.directory /data/workspace/zerohunger \
  && git config --system --add safe.directory /data/workspace/impactprotocol-core-edit

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]

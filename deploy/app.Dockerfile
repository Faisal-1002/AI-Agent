# seyl-ai "app" image: runs EITHER the OpenCode harness OR the backend API.
# Same code, same image — the container command decides which (see docker-compose.yml, k8s/).
FROM node:24-slim

# Tools OpenCode's file-search tools use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

# The OpenCode binary, pinned to the same version as @opencode-ai/sdk in package.json.
# (Installing the platform package directly skips opencode-ai's postinstall step.)
ARG OPENCODE_VERSION=1.18.33
ARG TARGETARCH
RUN arch="$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)" \
 && npm install -g "opencode-linux-${arch}@${OPENCODE_VERSION}" \
 && ln -s "/usr/local/lib/node_modules/opencode-linux-${arch}/bin/opencode" /usr/local/bin/opencode \
 && opencode --version

WORKDIR /app

# Dependencies first: this layer is cached until package*.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY shared ./shared
COPY --chown=node:node workspace /workspace
# A second copy that seeds the persistent workspace volume the first time (k8s initContainer).
COPY --chown=node:node workspace /workspace-seed

# OpenCode keeps sessions, caches and downloaded provider packages under XDG dirs.
# Point them all at /data so one volume persists everything.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    SEYL_WORKSPACE=/workspace \
    HOST=0.0.0.0 \
    OPENCODE_HOSTNAME=0.0.0.0 \
    XDG_DATA_HOME=/data/share \
    XDG_CACHE_HOME=/data/cache \
    XDG_STATE_HOME=/data/state \
    XDG_CONFIG_HOME=/data/config

# Don't run as root.
USER node

EXPOSE 3000 3001 4097
# Default: the backend API. The harness container overrides this with server/harness.ts.
CMD ["node", "--import", "tsx", "server/index.ts"]

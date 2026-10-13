# syntax=docker/dockerfile:1
#
# The remote code sandbox. Build from the REPOSITORY ROOT (the server runs against the library
# source in src/, no build step), like the team image:
#
#   docker build -f examples/sandbox-server/Dockerfile -t eharness-sandbox-server .
#   docker run -d --name sandbox -p 4100:4100 -e SANDBOX_TOKEN=change-me-please eharness-sandbox-server
#
# See examples/sandbox-server/README.md.

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS bun

# ─── deps: production dependencies of the workspace ──────────────────────────
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY examples/coder/package.json ./examples/coder/
COPY examples/team/package.json ./examples/team/
COPY examples/team/server/package.json ./examples/team/server/
COPY examples/sandbox-server/package.json ./examples/sandbox-server/
RUN bun install --frozen-lockfile --production --ignore-scripts

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# bubblewrap: scripts run under an OS sandbox inside the container when user namespaces are
# available (otherwise the container itself is the isolation: run it with an internal network).
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox
COPY examples/sandbox-server/requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/eh-python \
  && /opt/eh-python/bin/pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.json ./
COPY src ./src
COPY examples/sandbox-server ./examples/sandbox-server
# `eharness` resolves to the library source (see examples/team/Dockerfile)
RUN mkdir -p node_modules/eharness && ln -s /app/src node_modules/eharness/src \
  && bun -e "const p = await Bun.file('package.json').json(); \
     const exports = Object.fromEntries(Object.entries(p.exports).filter(([k]) => k !== './package.json') \
       .map(([k, v]) => [k, v.replace('./dist/', './src/').replace(/\.js\$/, '.ts')])); \
     await Bun.write('node_modules/eharness/package.json', JSON.stringify({ name: 'eharness', type: 'module', exports }))" \
  && mkdir -p /tmp/eh-sandboxes && chown sandbox:sandbox /tmp/eh-sandboxes

# SANDBOX_TOKEN is required (no default). Limits: see README.md.
ENV NODE_ENV=production \
    PORT=4100 \
    HOST=0.0.0.0 \
    PYTHON=/opt/eh-python/bin/python \
    SANDBOX_DATA=/tmp/eh-sandboxes

USER sandbox
WORKDIR /app/examples/sandbox-server
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 4100) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "src/main.ts"]

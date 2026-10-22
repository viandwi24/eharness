# syntax=docker/dockerfile:1
#
# The team example (server + web) in one image, on one port. Build from the REPOSITORY ROOT: the
# server runs against the library source in src/ (no build step), like in development.
#
#   docker build -f examples/team/Dockerfile -t eharness-team .
#   docker run -d --name team -p 4000:4000 --env-file examples/team/.env -v team-data:/data eharness-team
#
# Then open http://localhost:4000 and paste TEAM_TOKEN on the Settings page. The web is served at
# `/`, the API under `/api` (OpenAPI docs at /api/docs). All state (SQLite database, library files,
# dev key files) lives in the /data volume. See examples/team/README.md ("Docker").

ARG BUN_VERSION=1.4.2

# ─── web: static SPA build ───────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /app
COPY examples/team/web/package.json examples/team/web/bun.lock ./examples/team/web/
RUN cd examples/team/web && bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY examples/team/web ./examples/team/web
# the artifact kind registry is shared by the web and the server
COPY examples/team/shared ./examples/team/shared
# `eharness/client` is aliased to src/client, whose only runtime import (`ai`) must resolve from there
RUN ln -s /app/examples/team/web/node_modules /app/node_modules \
  && cd examples/team/web && bun run build

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
FROM oven/bun:${BUN_VERSION} AS runtime
# Python for `run_python` (TEAM_CODE_DRIVER=local runs it under bubblewrap in the container; the
# container needs unprivileged user namespaces: run it with `--security-opt seccomp=unconfined
# --security-opt apparmor=unconfined` (Docker's default profile blocks them). The server probes
# bubblewrap at boot; when it cannot create a namespace, code runs NOT isolated, Settings says why
# and the boot log warns. Or connect the Remote sandbox instead).
# The environment is built from wheels only, outside /data: nothing about code needs a volume.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv bubblewrap \
  && rm -rf /var/lib/apt/lists/*
# Browser profiles (P48): a managed Chrome is downloaded at runtime into /data/browser, never baked
# in; it needs these system libraries (and unzip to extract it). Build with
# `--build-arg TEAM_BROWSER_LIBS=0` for a smaller image without managed browsers (manual profiles,
# which connect to a browser running elsewhere, still work). Lightpanda needs none of them.
ARG TEAM_BROWSER_LIBS=1
RUN if [ "$TEAM_BROWSER_LIBS" = "1" ]; then \
    apt-get update \
    && ASOUND=$(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2) \
    && apt-get install -y --no-install-recommends unzip ca-certificates fonts-liberation \
       libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
       libxdamage1 libxfixes3 libxrandr2 libgbm1 "$ASOUND" libpango-1.0-0 libcairo2 xvfb xauth \
    && rm -rf /var/lib/apt/lists/*; \
  fi
COPY examples/team/python/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/eh-python \
  && /opt/eh-python/bin/pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.json ./
COPY src ./src
COPY examples/team/server ./examples/team/server
COPY examples/team/shared ./examples/team/shared
# the client of the Remote sandbox connector (`@eharness-examples/sandbox-server/client`)
COPY examples/sandbox-server/src ./examples/sandbox-server/src
COPY --from=web /app/examples/team/web/build ./examples/team/web/build
# `eharness` resolves to the library source: a package whose exports mirror the published ones,
# with ./dist/*.js mapped to ./src/*.ts (the image never builds dist/)
RUN mkdir -p node_modules/eharness && ln -s /app/src node_modules/eharness/src \
  && bun -e "const p = await Bun.file('package.json').json(); \
     const exports = Object.fromEntries(Object.entries(p.exports).filter(([k]) => k !== './package.json') \
       .map(([k, v]) => [k, v.replace('./dist/', './src/').replace(/\.js$/, '.ts')])); \
     await Bun.write('node_modules/eharness/package.json', JSON.stringify({ name: 'eharness', type: 'module', exports }))" \
  && mkdir -p /data && chown bun:bun /data

# Container defaults; everything else comes from the env file (see .env.example).
# A non-loopback bind requires TEAM_TOKEN (16+ characters) or BASIC_AUTH_PASSWORD (12+ characters, web login): the server refuses to start without one.
ENV NODE_ENV=production \
    TEAM_HOST=0.0.0.0 \
    PORT=4000 \
    TEAM_DB=/data/team.db \
    TEAM_CODE_PYTHON=/opt/eh-python/bin/python \
    TEAM_WEB_DIR=/app/examples/team/web/build \
    TEAM_PUBLIC_URL=http://localhost:4000/api

USER bun
WORKDIR /app/examples/team/server
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["bun", "scripts/serve.ts"]

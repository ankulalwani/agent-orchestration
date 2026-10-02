# Control plane image: API + web dashboard in one container (web served by the API).
# Build from the repository root:  docker build -f deployment/docker/control-plane.Dockerfile -t agent-orchestration .

FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# The API bundles the workspace packages (@ao/*); third-party packages stay external.
RUN pnpm --filter @ao/web build && pnpm --filter @ao/api build

# Production dependencies of the API, exactly as in pnpm-lock.yaml (`pnpm deploy` in pnpm 9 ignores the
# lockfile and would resolve versions afresh on every build).
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# Isolated layout (the default): only the API's packages, linked from node_modules/.pnpm.
RUN pnpm install --frozen-lockfile --prod --filter "@ao/api..."

FROM node:22-bookworm-slim
# The version shown on Server → Updates (set by the publish workflow from the tag).
ARG AO_VERSION=dev
ENV AO_VERSION=$AO_VERSION
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    WEB_DIST_DIR=/app/web \
    ARTIFACT_DIR=/app/data/artifacts
WORKDIR /app
# Same layout as in the repository, so the package links in apps/api/node_modules resolve.
COPY --from=prod-deps --chown=1000:1000 /repo/node_modules /app/node_modules
COPY --from=prod-deps --chown=1000:1000 /repo/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build --chown=1000:1000 /repo/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=1000:1000 /repo/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=1000:1000 /repo/apps/web/dist /app/web
# Writable data folder for artifacts (screenshots, logs) when S3 is not configured. Mount a volume here.
RUN mkdir -p /app/data/artifacts && chown -R 1000:1000 /app/data
# The image's `node` user, by number, so runtimes can verify it is not root (Kubernetes runAsNonRoot).
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

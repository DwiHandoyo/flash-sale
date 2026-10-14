# One Dockerfile for the whole repository, with one target per app. Each target is its own small
# image, started as a non-root user:
#   docker build --target api .        (or: worker, jobs, web)
# Docker Compose picks the target for each service.

# ---- Build: install the dependencies and build every app ---------------------------------------
FROM node:24-alpine AS build
WORKDIR /repo

# The manifests first, so the install is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/jobs/package.json apps/jobs/
COPY apps/web/package.json apps/web/
COPY tools/stress/package.json tools/stress/
RUN npm ci --no-audit --no-fund

COPY . .
# Each backend app becomes one bundled file (scripts/bundle.js); the web app becomes static files.
RUN npm run build --workspaces --if-present

# ---- Backend apps: Node.js plus one bundled file, no node_modules -------------------------------
FROM node:24-alpine AS node-app
ENV NODE_ENV=production
WORKDIR /app
USER node
# No --enable-source-maps: it makes every stack trace slow to build, which hurts exactly when a
# dependency is down and every failed request logs one. The bundle is not minified, so stack
# traces stay readable without it.
ENTRYPOINT ["node", "main.mjs"]

FROM node-app AS api
COPY --from=build /repo/apps/api/dist/ ./
EXPOSE 3000

FROM node-app AS worker
COPY --from=build /repo/apps/worker/dist/ ./

# The command picks the job: bootstrap (default), reconcile, recover, reset or schedule.
FROM node-app AS jobs
COPY --from=build /repo/apps/jobs/dist/ ./
CMD ["bootstrap"]

# The stress-test load generator (tools/stress). `npm run stress` starts it; it is never deployed.
FROM node-app AS stress
COPY --from=build /repo/tools/stress/dist/ ./

# ---- Web: nginx serves the React build and spreads /api over the API servers --------------------
FROM nginxinc/nginx-unprivileged:1.30-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /repo/apps/web/dist/ /usr/share/nginx/html/
EXPOSE 8080

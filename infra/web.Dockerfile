# Build and run the Specboards web app (self-host). Build context = repo root.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Standalone output so the runtime image only needs the traced server bundle.
ENV NEXT_OUTPUT=standalone
# Bake the running commit into the client bundle so the in-app "Source code"
# link (AGPL source availability, /legal) resolves to the exact source. Pass
# --build-arg GIT_SHA="$(git rev-parse --short HEAD)"; falls back to the repo
# root when unset. A self-hoster running a modified copy can also set
# NEXT_PUBLIC_SOURCE_REPO_URL to point the notice at their published fork.
ARG GIT_SHA=""
ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA
RUN pnpm build
# Bundle the migration runner into one self-contained file. The runtime image
# below is a Next standalone trace, which carries only what the server imports,
# so a script relying on its node_modules layout would be fragile. This has no
# runtime dependencies at all.
RUN pnpm --filter @specboards/db build:migrate

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# Copy the traced bundle owned by the unprivileged `node` user (shipped in the
# base image) so the runtime doesn't execute as root.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
# The migration runner and the SQL it applies, used by the Fly release_command
# (see the [deploy] block in fly.toml / fly.test.toml) and by a self-hoster
# upgrading by hand: `docker run --rm -e DATABASE_URL=... <image> node migrate.mjs`.
COPY --from=builder --chown=node:node /app/packages/db/dist/migrate.mjs ./migrate.mjs
COPY --from=builder --chown=node:node /app/infra/migrations ./migrations
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
USER node
CMD ["node", "apps/web/server.js"]

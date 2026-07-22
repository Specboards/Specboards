# Build and run the Specboards web app (self-host). Build context = repo root.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Standalone output so the runtime image only needs the traced server bundle.
ENV NEXT_OUTPUT=standalone
RUN pnpm build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# Copy the traced bundle owned by the unprivileged `node` user (shipped in the
# base image) so the runtime doesn't execute as root.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
USER node
CMD ["node", "apps/web/server.js"]

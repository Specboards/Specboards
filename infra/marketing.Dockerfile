# Build and run the SpecBoard marketing site (www.specboard.ai). Build context
# = repo root. Mirrors infra/web.Dockerfile but builds only @specboard/marketing,
# which has no workspace/runtime deps on the app, DB, or auth.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Standalone output so the runtime image only needs the traced server bundle.
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @specboard/marketing build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/marketing/.next/standalone ./
COPY --from=builder /app/apps/marketing/.next/static ./apps/marketing/.next/static
COPY --from=builder /app/apps/marketing/public ./apps/marketing/public
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/marketing/server.js"]

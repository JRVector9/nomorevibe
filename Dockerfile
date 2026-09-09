# Same source and lockfile; independent web and worker runtime targets.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS worker-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_DEPLOYMENT_ID
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}
RUN --mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,required=true npm run build

FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S worker -u 1001 -G nodejs
COPY --from=worker-deps --chown=worker:nodejs /app/node_modules ./node_modules
COPY --chown=worker:nodejs package.json package-lock.json tsconfig.json ./
COPY --chown=worker:nodejs lib ./lib
COPY --chown=worker:nodejs scripts ./scripts
COPY --chown=worker:nodejs drizzle ./drizzle
# Reviewer uses Claude; publisher category classification uses Codex. Pin both inspected CLIs.
ARG CLAUDE_CODE_VERSION=2.1.263
ARG CODEX_CLI_VERSION=0.153.4
RUN apk add --no-cache util-linux && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_CLI_VERSION} \
  && claude --version && codex --version
RUN mkdir -p /var/lib/nomorevibe-codex && chown worker:nodejs /var/lib/nomorevibe-codex
USER worker
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node --import tsx scripts/worker-healthcheck.ts
CMD ["node", "--import", "tsx", "scripts/worker-supervisor.ts", "--role=crawler"]

FROM worker AS connect-agent
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3020/rpc').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "scripts/connect-agent.ts"]

# Keep the default final target as the web image for existing docker build callers.
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh
USER nextjs
EXPOSE 3000
CMD ["./scripts/entrypoint.sh"]

# Next.js standalone 빌드용 멀티스테이지 이미지.
#
# standalone 출력은 실행에 필요한 node_modules만 추려 담으므로 최종 이미지가 작다.
# 대신 빌드 산출물에 없는 파일(skill/SKILL.md, drizzle/)은 명시적으로 넣어야 한다.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 빌드 중에는 DB에 접속하지 않지만, 모듈 로드 시점에 값이 있어야 하는 코드가 있으면
# 여기서 막히지 않도록 형식만 맞는 값을 준다 (실제 연결은 런타임에 일어난다)
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# root로 돌리지 않는다
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 마이그레이션 SQL과 실행기. 빌드 산출물이 아니므로 따로 넣는다.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --chown=nextjs:nodejs scripts/migrate.mjs ./scripts/migrate.mjs

# 마이그레이터는 앱이 쓰지 않아 파일 추적에서 빠진다. 추적에 기대면 조용히 깨지므로
# 마이그레이션에 필요한 두 패키지를 전체로 덮어쓴다 (standalone에 있는 것은 일부만 추려진 사본이다).
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres ./node_modules/postgres
COPY --chown=nextjs:nodejs scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN chmod +x ./scripts/entrypoint.sh

USER nextjs
EXPOSE 3000

# 마이그레이션을 적용한 뒤 서버를 띄운다. 실패하면 시작하지 않는다 —
# 스키마가 어긋난 채로 도는 것이 더 나쁘다.
CMD ["./scripts/entrypoint.sh"]

import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import journal from '@/drizzle/meta/_journal.json';
import type { db } from '@/lib/db';
import { serviceInstanceId } from './instance';

type HealthEnvironment = Readonly<Record<string, string | undefined>>;

export function healthIdentity(env: HealthEnvironment = process.env) {
  return {
    instanceId: serviceInstanceId(env) ?? 'legacy',
    release: env.RELEASE_TAG ?? env.NEXT_DEPLOYMENT_ID ?? 'unknown',
  };
}

/** 프록시만 붙이는 머리 — Next 서버는 스스로 넣지 않는다. Traefik 은 X-Real-Ip·X-Forwarded-Server 를, Cloudflare 는 CF-Ray·CF-Connecting-IP·CDN-Loop 를 늘 붙인다 */
const PROXY_ONLY_HEADERS = [
  'forwarded', 'via', 'x-real-ip', 'x-forwarded-server', 'true-client-ip',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop',
] as const;
/** 포트까지 적힌 Host — 컨테이너·호스트 안 호출자는 `주소:3000` 처럼 포트를 적는다. 공개 주소(nomorevibe.com)에는 포트가 없다 */
const HOST_WITH_PORT = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]{1,253}):\d{1,5}$/;

/**
 * 프록시를 거치지 않고 웹 서버에 바로 붙은 요청인가 — 배포 도구의 docker exec fetch(`http://$HOSTNAME:3000`), compose healthcheck
 * (127.0.0.1:3000), recovery gateway 의 직접 확인. 아니면 공개 요청으로 보고 /api/health 는 상태만 낸다(2026-11-16 Grok 크롤링).
 *
 * "전달 머리가 하나도 없다"로는 가릴 수 없다: Next 16 은 모든 요청에 x-forwarded-for(소켓 주소)·-host(Host)·-port(듣는 포트)·
 * -proto(http)를 **비어 있을 때만** 채운다(next/dist/server/base-server.js, 16.4.1 standalone 에서 직접 확인). 그래서 직접 요청도 넷을 가진다.
 * 대신 넷이 Next 가 직접 연결에 채우는 모양 그대로이고 프록시만 붙이는 머리가 하나도 없을 때만 직접 요청으로 본다:
 *  - PROXY_ONLY_HEADERS 가 하나라도 있으면 공개다. Traefik 은 믿지 않는 피어가 보낸 X-Forwarded-*·X-Real-Ip 를 지우고 다시 쓰므로
 *    Traefik 을 거친 요청은 Cloudflare 경유든 아니든 늘 X-Real-Ip·X-Forwarded-Server 를 가진다. 바깥 클라이언트는 그 머리를 없앨 수 없다.
 *  - x-forwarded-for 는 IP 하나(여러 hop 이면 프록시를 거쳤다), x-forwarded-proto 는 http(TLS 를 푼 프록시가 없다),
 *    Host 는 포트까지 적혀 있고 x-forwarded-host 와 같아야 한다.
 * 머리가 없거나 모양이 하나라도 다르면 공개로 본다 — 확실하지 않으면 덜 낸다. 머리는 덜 내는 쪽으로만 쓰이고 비밀·새 설정은 없다.
 * 신뢰 모델은 lib/rate-limit.ts 와 같다: 원 서버는 Cloudflare Tunnel → Traefik 으로만 공개되고, 웹 컨테이너 포트에 바로 닿는 쪽
 * (같은 호스트·컨테이너, 배포 도구의 SSH+docker exec)은 운영자다.
 */
export function directServerRequest(headers: Pick<Headers, 'get'>): boolean {
  if (PROXY_ONLY_HEADERS.some(name => headers.get(name) !== null)) return false;
  const host = headers.get('host');
  const forwardedFor = headers.get('x-forwarded-for')?.trim() ?? '';
  return host !== null && HOST_WITH_PORT.test(host)
    && headers.get('x-forwarded-host') === host
    && headers.get('x-forwarded-proto') === 'http'
    && isIP(forwardedFor) !== 0;
}

/** 이 빌드가 기대하는 마지막 migration(빌드 때 묶인 journal 의 마지막 항목) */
export const EXPECTED_MIGRATION = journal.entries[journal.entries.length - 1];
export type SchemaReadiness = 'ok' | 'pending' | 'unverified';

/**
 * 웹이 기대하는 migration 이 DB 에 적용됐나. drizzle 마이그레이터와 같은 기준이다 — 적용분의 최대 created_at 이 journal 의 when 이상이면
 * 적용됐다(DB 가 코드보다 앞선 롤백 배포도 ok). 0095 없이 배포되면 웹 쓰기·로그인·action·webhook 이 모두 실패했는데 select 1 만 보던 health 는
 * 200 이었다(R4). 기록 표를 읽지 못하면(표·schema 없음·권한 없음) 확인하지 못한 것이다 — ok 로 보지 않는다.
 */
export async function schemaReadiness(database: Pick<typeof db, 'execute'>): Promise<SchemaReadiness> {
  try {
    const [row] = await database.execute<{ latest: string | null }>(sql`select max(created_at)::text as latest from drizzle.__drizzle_migrations`);
    return row?.latest != null && Number(row.latest) >= EXPECTED_MIGRATION.when ? 'ok' : 'pending';
  } catch {
    return 'unverified';
  }
}

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

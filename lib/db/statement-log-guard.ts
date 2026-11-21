import { sql } from 'drizzle-orm';
import type { db } from '@/lib/db';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 이 트랜잭션의 느린 문장 로그에 bind 값을 남기지 않는다 — `SET LOCAL log_parameter_max_length = 0`.
 *
 * 운영 주 DB 는 500ms 를 넘긴 문장을 bind 값(256자까지)과 함께 서버 로그에 남긴다(docs/operations/2026-11-15-db-disk-outage.md b).
 * 개인정보(제작자 이메일 등)를 bind 값으로 보내는 트랜잭션은 먼저 이것을 부른다. log_parameter_max_length 는 superuser 설정이라
 * 앱 역할은 `GRANT SET ON PARAMETER log_parameter_max_length TO <앱 역할>`(PG15+, superuser 가 한 번) 뒤에만 바꿀 수 있다.
 * 권한이 없으면 오류 없이 false — 권한을 먼저 물어(has_parameter_privilege) 거절될 SET 을 보내지 않는다(거절은 DB 로그에 ERROR 를 남긴다).
 * 모두 제 저장점 안에서 하므로 뜻밖에 실패해도 부른 쪽 트랜잭션은 깨지지 않는다. 바꾼 값은 바깥 트랜잭션이 끝나면 돌아간다.
 */
export async function hideBindValuesInStatementLog(tx: Transaction): Promise<boolean> {
  try {
    return await tx.transaction(async (inner) => {
      const [probe] = await inner.execute<{ available: boolean }>(sql`SELECT to_regprocedure('pg_catalog.has_parameter_privilege(text,text)') IS NOT NULL AS available`);
      if (!probe?.available) return false;
      const [grant] = await inner.execute<{ allowed: boolean }>(sql`SELECT has_parameter_privilege('log_parameter_max_length', 'SET') AS allowed`);
      if (!grant?.allowed) return false;
      await inner.execute(sql`SET LOCAL log_parameter_max_length = 0`);
      return true;
    });
  } catch {
    return false;
  }
}

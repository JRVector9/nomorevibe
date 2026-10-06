import { assertLocalTestDatabase } from "../../scripts/test-database";
import { execSync } from "node:child_process";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";

/**
 * 통합 테스트용 DB 준비.
 *
 * 개발 DB가 아니라 전용 DB(기본 포트 55435)를 쓴다. 테스트가 테이블을 비우므로
 * 실수로 개발 DB를 가리키면 작업 중인 데이터가 날아간다.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test";

assertLocalTestDatabase(TEST_DATABASE_URL);

let migrated = false;

/** 스키마를 최신 마이그레이션 상태로 맞춘다 (파일당 한 번) */
export function ensureSchema() {
  if (migrated) return;
  execSync("npx drizzle-kit migrate", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
  migrated = true;
}

/**
 * 테이블을 비운다.
 *
 * 트랜잭션 롤백 대신 TRUNCATE를 쓰는 이유: 유스케이스가 자체적으로 커밋하는
 * 여러 쿼리(insert 후 setOgImage 등)를 실행하므로, 바깥에서 트랜잭션으로 감싸면
 * 실제 커밋 경계를 재현하지 못한다. 경합 재시도 같은 동작은 진짜 커밋이 있어야 검증된다.
 */
export async function resetTables() {
  await db.execute(sql`
    TRUNCATE product_audit_campaigns, product_refresh_requests, agent_repository_observations, agent_repository_scans, crawl_discovery_evidence,
             product_evidence_audit, product_skills, product_agents, product_updates,
             product_media, product_media_declarations, media_assets, product_evidence_sources, product_links,
             product_profiles, evidence_settings, product_health_daily,
             product_health,
             ranking_entries, ranking_seasons, ranking_policy_revisions,
             click_events, product_click_daily, visit_collection_state,
             products, og_images, cdn_purges RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`
    INSERT INTO visit_collection_state (id, unique_visitor_started_at)
    VALUES (1, NULL)
  `);
}

/**
 * 작업 로그는 지울 수 없다(0056) — 테스트끼리 남긴 줄이 쌓인다. 시작할 때의 마지막 id 를 잡아 두고
 * 그 뒤에 생긴 줄만 본다.
 */
export async function auditFloor(): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${operationsAudit.id}), 0)::int` }).from(operationsAudit);
  return row.max;
}

export function auditRowsAfter(floor: number, action?: string) {
  return db.select().from(operationsAudit)
    .where(and(gt(operationsAudit.id, floor), action ? eq(operationsAudit.action, action) : undefined));
}

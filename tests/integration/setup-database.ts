import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assertLocalTestDatabase } from "../../scripts/test-database";
import { TEST_DATABASE_URL } from "./test-database-url";

assertLocalTestDatabase(TEST_DATABASE_URL);

let migrated = false;

/** Prepare the isolated test database once per process. Shared by Vitest and Playwright. */
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
    TRUNCATE admin_contact_requests, github_webhook_events, github_integration_actions, github_issue_outbox, github_star_operation_receipts, github_star_operations,
             github_auth_flows, github_user_connections,
             email_login_challenges, public_sessions, public_identities, public_users, rate_limits,
             product_audit_campaigns, product_refresh_requests, agent_repository_observations, agent_repository_scans, crawl_discovery_evidence, repository_ai_levels,
             product_evidence_audit, product_skills, product_agents, product_updates,
             product_media, product_media_declarations, media_assets, product_evidence_sources, product_links,
             product_profiles, evidence_settings, product_health_daily,
             product_health,
             ranking_entries, ranking_seasons, ranking_policy_revisions,
             click_events, product_click_daily, visit_collection_state,
             product_audit_policy_run_items, product_audit_policy_runs, product_recheck_baselines,
             products, og_images, cdn_purges RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`
    INSERT INTO visit_collection_state (id, unique_visitor_started_at)
    VALUES (1, NULL)
  `);
}

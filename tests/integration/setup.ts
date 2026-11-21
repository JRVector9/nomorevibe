import { and, eq, gt, sql } from "drizzle-orm";
import { inject } from "vitest";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { ensureSchema as migrateDatabase } from "./setup-database";
import { TEST_DATABASE_URL } from "./test-database-url";

export { TEST_DATABASE_URL };
export { resetTables } from "./setup-database";

/** Skip the extra migration when Vitest globalSetup has prepared this test database. */
export function ensureSchema() {
  let ready: string | undefined;
  try { ready = inject("integrationSchemaReady"); } catch { /* No Vitest run context. */ }
  if (ready !== TEST_DATABASE_URL) migrateDatabase();
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

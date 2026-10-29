import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 적체 차선(postprocess-backlog-*) 통합 시험의 요청 장부 fixture. 실제 요청 API 로 남의 대기·예약 행을 만들고,
 * 끝나면 이 fixture 가 만든 owner 의 행·사건만 지우고 운영 모드를 원래 값으로 되돌린다.
 */
export const FIXTURE_OWNER_PREFIX = "postprocess-backlog-";
export const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
let saved: Record<string, unknown> | null | undefined;

export function fixtureOwner(name: string) {
  return { instanceId: `${FIXTURE_OWNER_PREFIX}${name}`, bootId: randomUUID() };
}

export function policy(routes: { routeId: string; model: string }[], groupLimit = 4): ModelCapacityPolicy {
  return { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: groupLimit },
    poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
    queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: routes.map(route => ({ ...route, provider: "abcllm", providerBudgetId: "account", groupId: "engine" })) };
}

export async function setCapacityMode(mode: "open" | "disabled" | "draining", value?: ModelCapacityPolicy) {
  if (saved === undefined) {
    const [row] = await admin`SELECT to_jsonb(c) AS raw FROM model_capacity_control c WHERE id=1`;
    saved = (row?.raw as Record<string, unknown> | undefined) ?? null;
    if (!saved) await admin`INSERT INTO model_capacity_control (id) VALUES (1)`;
  }
  if (value) await admin`UPDATE model_capacity_control SET mode=${mode}, policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)}, cursor=0, updated_at=clock_timestamp() WHERE id=1`;
  else await admin`UPDATE model_capacity_control SET mode=${mode}, updated_at=clock_timestamp() WHERE id=1`;
}

export async function cleanupCapacityFixture() {
  // 사건 표는 append-only 다 — 이 fixture owner 의 행만, 기존 시험(action-audit-dispatch)과 같은 방식으로 지우고 trigger 를 되돌린다
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id LIKE ${`${FIXTURE_OWNER_PREFIX}%`}
      FOR UPDATE`).map(row => row.request_id);
    if (!ids.length) return;
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
  });
  if (saved === undefined) return;
  if (saved === null) await admin`DELETE FROM model_capacity_control WHERE id=1`;
  else await admin`UPDATE model_capacity_control SET mode=${String(saved.mode)},
    policy=${saved.policy === null ? null : JSON.stringify(saved.policy)}::text::jsonb, policy_hash=${saved.policy_hash as string | null},
    epoch=${Number(saved.epoch)}, revision=${Number(saved.revision)}, cursor=${Number(saved.cursor)} WHERE id=1`;
  saved = undefined;
}

/** 장부 fence 와 같은 상태 판정을 실제 표 대신 이 행들로 — dispatched·indeterminate 는 결속 증명 없이 만들 수 없어 CTE 로 가린다 */
export function shadowRequests(rows: { state: string; owner: string; boot: string; members?: string[]; logical?: string }[], mode = "open") {
  const values = rows.map(row => sql`(${row.state}::text, ${row.owner}::text, ${row.boot}::uuid,
    ${row.members ? sql`ARRAY[${sql.join(row.members.map(key => sql`${key}`), sql`, `)}]::text[]` : sql`NULL::text[]`},
    ${row.logical ?? null}::text)`);
  return sql`WITH model_capacity_requests AS (SELECT * FROM (VALUES ${sql.join(values, sql`, `)})
      AS r(state, owner_instance_id, owner_boot_id, logical_member_keys, logical_work_key)),
    model_capacity_control AS (SELECT 1 AS id, ${mode}::text AS mode)`;
}

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { operationsAudit } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { adminAuditRow } from "./admin-log";
import { bindWriterFence } from "./dr/epoch";
import { insertEvidenceRecorderMarker } from "./pipeline-evidence-ledger";

/**
 * 0097 증거 장부 기록 시작 marker 운영자 CLI(F1, scripts/ops/pipeline-evidence-marker.ts)의 순수 인자 해석과 DB 동작.
 * marker는 지울 수 없고(append-only) 하나뿐이다. 판정은 marker가 구간 시작 이전인 구간만 장부로 센다.
 */
type Database = PostgresJsDatabase<typeof schema>;
export type EvidenceMarkerCommand = { revision: string; operator: string; execute: boolean; json: boolean };
export type EvidenceMarker = { startedAt: string; revision: string; operator: string };
function fail(code: string): never { throw new Error(code); }

/** --revision(7–40자리 소문자 hex)·--operator(앞뒤 공백 없는 1–120자)는 필수다. --execute 없으면 dry-run이다. URL 인자는 거부한다. */
export function parseEvidenceMarkerArgs(args: readonly string[]): EvidenceMarkerCommand {
  if (args.some(arg => arg.includes("://"))) fail("pipeline_evidence_marker_url_argument_rejected");
  const values = new Map<string, string>(), flags = new Set<string>();
  for (const arg of args) {
    const match = /^--(revision|operator|execute|json)(?:=([^\n]*))?$/.exec(arg);
    if (!match) fail("pipeline_evidence_marker_unknown_option");
    const [, key, value] = match;
    if (key === "execute" || key === "json") {
      if (value !== undefined || flags.has(key)) fail("pipeline_evidence_marker_unknown_option");
      flags.add(key);
    } else {
      if (value === undefined || values.has(key)) fail("pipeline_evidence_marker_unknown_option");
      values.set(key, value);
    }
  }
  const revision = values.get("revision"), operator = values.get("operator");
  if (!revision || !/^[a-f0-9]{7,40}$/.test(revision)) fail("pipeline_evidence_marker_revision_required");
  if (!operator || operator !== operator.trim() || operator.length > 120 || /[\u0000-\u001f\u007f]/.test(operator)) fail("pipeline_evidence_marker_operator_required");
  return { revision, operator, execute: flags.has("execute"), json: flags.has("json") };
}

/** 읽기 전용: 기록 시작 marker. 표가 없거나(0097 전) 읽을 권한이 없으면 readable=false다. */
export async function readEvidenceRecorder(database: Database): Promise<{ readable: boolean; marker: EvidenceMarker | null }> {
  const [table] = await database.execute<{ readable: boolean }>(sql`select
    coalesce(has_table_privilege(to_regclass('public.pipeline_evidence_events'), 'SELECT'), false) as readable`);
  if (!table.readable) return { readable: false, marker: null };
  const [row] = await database.execute<{ started_at: string; revision: string; operator: string }>(sql`select revision, operator,
    to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at from pipeline_evidence_events where kind = 'recorder_started'`);
  return { readable: true, marker: row ? { startedAt: row.started_at, revision: row.revision, operator: row.operator } : null };
}

/**
 * --execute: 한 TX에서 writer fence(share, fenced DB면 거절) → marker(이미 있으면 그대로) → 새로 남겼을 때만 관리자 작업 로그를
 * 같은 커밋에 남긴다(스크립트 행 관례: actor_kind 없음). 돌려주는 marker는 저장된 그대로(이미 있었으면 그 값)다.
 */
export async function recordEvidenceRecorderStart(database: Database, input: { revision: string; operator: string }):
  Promise<{ inserted: boolean; marker: EvidenceMarker; auditId: number | null }> {
  return database.transaction(async tx => {
    await bindWriterFence(tx);
    const inserted = await insertEvidenceRecorderMarker(tx, input);
    const [row] = await tx.execute<{ started_at: string; revision: string; operator: string }>(sql`select revision, operator,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at from pipeline_evidence_events where kind = 'recorder_started'`);
    const marker = { startedAt: row.started_at, revision: row.revision, operator: row.operator };
    let auditId: number | null = null;
    if (inserted) {
      const audit = await adminAuditRow(input.operator, { action: "pipeline-evidence-recorder-start", target: "pipeline_evidence_events",
        detail: { revision: input.revision, startedAt: marker.startedAt } });
      [{ id: auditId }] = await tx.insert(operationsAudit).values({ ...audit, actorKind: null }).returning({ id: operationsAudit.id });
    }
    return { inserted, marker, auditId };
  });
}

/** 고정 code만 출력한다. URL·SQL·stack은 쓰지 않는다. */
export function formatEvidenceMarkerError(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "pipeline_evidence_marker_failed";
}

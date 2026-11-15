import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ProductTransaction } from "@/lib/domain/products/generation";

/**
 * 모델 장부 보관 기간(2026-11-15 소유자 승인 DB 보관 ⑤) — 끝난 장부 행을 몇 날 뒤에 지우는가의 단일 출처.
 *
 * - 값은 runtime_settings `capacity.ledgerRetentionDays`(관리자 「장비 한도 › 모델 장부 보관」)다. 기본 14일.
 * - 바닥 8일: LLM 보조 주간 상한(lib/domain/llm-assist)이 UTC 한 주(최대 7일) 안의 dispatched_at 을 센다 — 그보다 짧으면 주간 상한이
 *   지운 만큼 덜 센다. 같은 바닥을 DB 트리거(drizzle/0187_db_retention.sql nmv_model_capacity_retention_expired)가 한 번 더 지킨다.
 * - 천장 90일: 하루 0.35~0.4 GB(2026-11-13·14 운영 실측)라 그 이상은 디스크를 다시 채운다.
 * - 지우는 것은 끝난 행(settled 는 settled_at, withdrawn 은 updated_at 기준)과 그 이벤트 전부뿐이다(lib/operations/db-retention.ts).
 */
export const DEFAULT_MODEL_CAPACITY_LEDGER_RETENTION_DAYS = 14;
export const MODEL_CAPACITY_LEDGER_RETENTION_DAYS_MIN = 8;
export const MODEL_CAPACITY_LEDGER_RETENTION_DAYS_MAX = 90;
export const ledgerRetentionDaysSchema = z.number().int().min(MODEL_CAPACITY_LEDGER_RETENTION_DAYS_MIN).max(MODEL_CAPACITY_LEDGER_RETENTION_DAYS_MAX);

/** 저장 문서의 `capacity.ledgerRetentionDays` 값 → 일. 없거나 읽을 수 없으면 기본값(resolveRuntimeSettings 와 같은 거르기). */
export function ledgerRetentionDaysFromStored(raw: unknown): number {
  const parsed = ledgerRetentionDaysSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_MODEL_CAPACITY_LEDGER_RETENTION_DAYS;
}

/** 지금의 보관 기간(일)을 runtime_settings 행에서 바로 읽는다(30초 스냅숏이 아니다 — 정리 틱마다 한 번). */
export async function readModelCapacityLedgerRetentionDays(executor: Pick<ProductTransaction, "execute">): Promise<number> {
  const [row] = await executor.execute<{ days: unknown }>(sql`SELECT rs."values"->'capacity'->'ledgerRetentionDays' AS days FROM runtime_settings rs WHERE rs.id = 1`);
  return ledgerRetentionDaysFromStored(row?.days);
}

import "server-only";
import { like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { observe } from "./observations";
import { webWritable } from "./dr/web-gate";
import { claimDirectProbes, directProbeTargets, runDirectProbes, type EndpointModelsReader } from "./admin-models-direct-probe";
import type { StoredServingContract } from "@/lib/llm/serving-contract-store";
import type { ModelCard } from "./admin-models-view";
import { parseProbeObservation, probeObservationKey, probeObservationValue, PROBE_OBSERVATION_PREFIX,
  type ProbeObservation, type ProbeResultLike, type ProbeSource } from "./admin-models-probe";

export type ProbeIdentity = { routeId?: string | null; provider: string; model: string };

/** 연결 확인 결과 한 건을 그 슬롯의 키에 upsert 한다. 서버 액션(수동)이 부른다 — 관문(webWriteAction)은 액션이 이미 지났다. */
export async function saveProbeObservation(identity: ProbeIdentity, result: ProbeResultLike, source: ProbeSource, detail: string | null = null):
  Promise<{ key: string; observedAt: string }> {
  const key = probeObservationKey(identity);
  await observe(key, probeObservationValue(identity, result, source, detail));
  return { key, observedAt: new Date().toISOString() };
}

/**
 * 렌더 때의 자동 확인(사람 위임·카테고리·검색 서버·엔진 직접 연결) 결과를 남긴다. 화면 그리기 안에서 부르므로 실패해도 던지지 않고,
 * DR 로 쓰기가 막힌 사이트(webWritable 거짓)에서는 건너뛴다 — 읽기 화면이 쓰기 관문을 깨지 않는다.
 */
export async function recordAutoProbes(entries: readonly { identity: ProbeIdentity; result: ProbeResultLike; detail?: string | null }[]): Promise<number> {
  if (!entries.length || !(await webWritable())) return 0;
  const settled = await Promise.allSettled(entries.map(entry => saveProbeObservation(entry.identity, entry.result, "auto", entry.detail ?? null)));
  return settled.filter(row => row.status === "fulfilled").length;
}

/**
 * 엔진 직접 연결 계약의 자동 확인(admin-models-direct-probe.ts) — 대상 고르기 → 저장된 관측·프로세스 안 시도로 1분 간격 거르기 → GET /models
 * (같은 주소는 한 번) → recordAutoProbes. 화면 그리기 안에서 부르므로 던지지 않고 저장한 건수를 돌려준다. 쓰기가 막힌 사이트에서는 부르지도 않는다.
 */
export async function autoProbeDirectEngines(cards: readonly ModelCard[], rows: readonly StoredServingContract[], read: EndpointModelsReader,
  now: number = Date.now()): Promise<number> {
  try {
    const targets = directProbeTargets(cards, rows);
    if (!targets.length || !(await webWritable())) return 0;
    const due = claimDirectProbes(targets, await readProbeObservations(), now);
    return due.length ? await recordAutoProbes(await runDirectProbes(due, read)) : 0;
  } catch { return 0; }
}

/** 저장된 연결 확인 관측 전부(키 → 값). 읽기 실패는 빈 표 — 화면은 「확인 기록 없음」으로 그린다. */
export async function readProbeObservations(): Promise<Record<string, ProbeObservation>> {
  try {
    const rows = await db.select({ key: operationsObservations.key, value: operationsObservations.value,
      observedAt: sql<string>`to_char(${operationsObservations.observedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` })
      .from(operationsObservations).where(like(operationsObservations.key, `${PROBE_OBSERVATION_PREFIX}%`));
    const result: Record<string, ProbeObservation> = {};
    for (const row of rows) { const parsed = parseProbeObservation(row); if (parsed) result[parsed.key] = parsed; }
    return result;
  } catch { return {}; }
}

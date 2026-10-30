import { effectiveJobBudgetMs } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/** 틱 끝의 기록 여유 — 호출의 제한 시간은 여기까지 못 미친다(예전 잡별 TICK_MS 가 예산보다 1초 짧았던 것과 같다) */
export const TICK_WRITE_MARGIN_MS = 1_000;

/**
 * 틱의 남은 시간(ms)을 주는 함수 — 글 짓는 잡들(사유 번역·소개 생성·한국어 소개·검색 키워드·키워드 검수·소개 검수)이
 * "이만큼 남아 있을 때만 새로 부른다"에 쓴다.
 *
 * 기준은 러너가 준 ctx.deadlineAt(= 틱 시작 + 틱 예산, lib/jobs/runner.ts)이다. 예산은 runtime_settings 의 budgets 에서 와
 * 관리자가 저장하면 다음 틱부터 바뀐다 — 잡 안의 TICK_MS 상수(예산 − 1초)를 두면 저장이 그 상수에 닿지 않아 걷어냈다(실시간 한도 D4).
 * deadlineAt 이 없는 직접 호출(테스트·러너를 거치지 않는 호출)은 그 잡의 유효 예산(effectiveJobBudgetMs — 예산 줄이 없는 잡은
 * runner 기본 25초)으로 본다. 러너를 거치면 늘 deadlineAt 이 있다.
 */
export function tickRemaining(ctx: { deadlineAt?: number }, job: string, startedAt = Date.now()): () => number {
  const deadlineAt = ctx.deadlineAt ?? startedAt + effectiveJobBudgetMs(job, runtimeSettings());
  return () => deadlineAt - TICK_WRITE_MARGIN_MS - Date.now();
}

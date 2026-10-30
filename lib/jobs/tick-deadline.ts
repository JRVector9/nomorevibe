import { effectiveJobBudgetMs } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/** 틱 끝의 기록 여유 — 호출의 제한 시간은 여기까지 못 미친다(예전 잡별 TICK_MS 가 예산보다 1초 짧았던 것과 같다) */
export const TICK_WRITE_MARGIN_MS = 1_000;

/**
 * 틱의 남은 시간(ms)을 주는 함수 — 글 짓는 잡들(사유 번역·소개 생성·한국어 소개·검색 키워드·키워드 검수·소개 검수)이
 * "이만큼 남아 있을 때만 새로 부른다"와 호출 제한 시간 줄이기에 쓴다. 예전 잡별 TICK_MS 상수(예산 − 1초)를 대신한다(실시간 한도 D4).
 *
 * 창의 끝은 러너가 준 ctx.deadlineAt(= 틱 시작 + 틱 예산, lib/jobs/runner.ts)과 이 잡의 유효 예산(effectiveJobBudgetMs — runtime_settings budgets,
 * 관리자가 저장하면 다음 틱부터 바뀐다) 중 늦은 쪽이다.
 * - 워커(scripts/worker.ts jobRunOptions)는 같은 고정 판의 유효 예산을 러너에 주므로 둘이 같다 — 저장이 창과 알린 예산을 함께 움직인다(D3).
 * - 러너를 거치지 않거나 예산 없이 runJob 을 부른 곳(테스트·직접 호출: 러너 기본 25초)은 잡의 유효 예산으로 계획한다 — TICK_MS 시절과 같다.
 *   창은 계획일 뿐이고 러너의 hasBudget()·signal 이 여전히 끊는 선이다(예전과 같다).
 * - 더 큰 예산을 명시한 러너(run-job --budget)는 그만큼 창이 넓어진다.
 * 예산 줄이 없는 잡(crawl-tagline)의 유효 예산은 runner 기본 25초다.
 */
export function tickRemaining(ctx: { deadlineAt?: number }, job: string, startedAt = Date.now()): () => number {
  const configured = startedAt + effectiveJobBudgetMs(job, runtimeSettings());
  const deadlineAt = Math.max(ctx.deadlineAt ?? configured, configured);
  return () => deadlineAt - TICK_WRITE_MARGIN_MS - Date.now();
}

import type { ReviewInput, ReviewOutcome } from "./agent-review-contract";
import { reviewWithGateway } from "./agent-review-gateway";
import { qwenDirectFailure } from "./qwen-direct-review";

/**
 * 공개분 변경 재판정의 API 순위 한 번(2026-11-09) — 「작업 ↔ 모델」 순위의 연결 주소·모델·키로 OpenAI 호환 엔진에 바로 묻는다(감사 직접 경로 local-audit).
 * 주소·모델은 순위에서만 온다 — env(AUDIT_SECOND_OPINION_URL·_MODEL)·등록부 기본값을 읽지 않는다.
 *
 * 글은 1차 심사·사람이 연 감사의 게이트웨이 심사와 같다(reviewWithGateway 의 정책 글 + GATEWAY_SYSTEM_SUFFIX, 판 REVIEW_PROMPT_VERSION) — 재판정의 CLI 순위와
 * 같은 판으로 묻는다. Qwen-v2 덧붙임(QWEN_V2_ADDENDUM)은 gpu3090 Qwen 한 모델의 두 번째 의견을 사람 판단과 견줘 맞춘 글이라 여기서는 붙이지 않는다
 * (그 덧붙임은 두 번째 의견·남은 감사 Qwen 길에만 그대로 있다). thinking 칸은 로컬 계약이 정한다(local-model-capacity.ts 가 wire 의 것을 바꾼다).
 * 실패는 Qwen 직접 심사와 같은 고정 코드(QwenDirectError)로 던진다. DB 트랜잭션 안에서 부르지 않는다.
 */
export async function reviewWithRecheckEndpoint(input: ReviewInput, opts: {
  baseUrl: string; apiKey: string | null; model: string; timeoutMs: number; signal?: AbortSignal;
  /** 장부 입장이 묶은 요청(withLocalModelCapacity) — 시험은 가짜 서버 */
  request?: typeof fetch;
}): Promise<ReviewOutcome> {
  // 답의 HTTP 상태 — reviewWithGateway 는 상태를 갈래(auth·rate_limited…)로만 돌려준다
  const seen: { status: number | null } = { status: null };
  const request = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await (opts.request ?? fetch)(url, { ...init, redirect: "error" });
    seen.status = response.status;
    return response;
  }) as typeof fetch;
  const result = await reviewWithGateway(input, { model: opts.model, timeoutMs: opts.timeoutMs, signal: opts.signal, request,
    endpoint: { baseUrl: opts.baseUrl, apiKey: opts.apiKey } });
  if (result.ok) return result.outcome;
  throw qwenDirectFailure(result, seen.status);
}

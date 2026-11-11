import { expect } from "vitest";
import { readGatewayHttpRejected } from "@/lib/crawl/agent-review-gateway";

/**
 * 0174: text 경로 전송 함수의 실패 반환에서 처리 전 거절 증인(rejected)을 떼어 확인하고 나머지를 돌려준다. 상태가 429·401·403 이면 이 dispatch 의
 * gateway_http_rejected 증인(원본 등록부에서 읽힌다)이 있어야 하고, 그 밖의 상태(다른 4xx·5xx·3xx)는 증인이 없어야 한다(지금처럼 결과 미확정).
 */
export function withoutRejected<T extends { rejected?: unknown }>(outcome: T, status: number, dispatch: unknown,
  retryAfterMs: number | null = null): Omit<T, "rejected"> {
  const { rejected, ...rest } = outcome;
  if ([401, 403, 429].includes(status)) {
    expect(readGatewayHttpRejected(rejected)).toEqual({ version: 1, kind: "gateway_http_rejected", dispatch, status, retryAfterMs });
    // 사본은 권한이 아니다 — 같은 모양의 다른 객체는 등록부에 없다
    expect(readGatewayHttpRejected(structuredClone(rejected))).toBeNull();
  } else expect(rejected).toBeUndefined();
  return rest;
}

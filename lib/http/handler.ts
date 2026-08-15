import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";

/**
 * 라우트 에러 경계.
 *
 * 없으면 예외가 그대로 500이 되고 무슨 일이 났는지 알 방법이 없다.
 * 모든 요청에 ID를 붙여 응답 헤더로 돌려주므로, 사용자가 문제를 제보할 때
 * 그 ID 하나로 해당 요청의 로그를 찾을 수 있다.
 */

// Next.js 라우트 핸들러는 항상 (request, context) 형태다.
// params를 쓰지 않는 핸들러도 시그니처는 이 형태를 유지해야 한다.
export type RouteContext = { params: Promise<Record<string, string>> };
type Handler<C extends RouteContext> = (req: Request, ctx: C) => Promise<Response>;

export function withRoute<C extends RouteContext = RouteContext>(
  name: string,
  handler: (req: Request, ctx: C) => Promise<Response>,
): Handler<C> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const base = { requestId, route: name, method: req.method };

    try {
      const res = await handler(req, ctx);
      const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
      logger[level]("http.request", { ...base, status: res.status, durationMs: Date.now() - startedAt });
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (error) {
      // 처리되지 않은 예외 — 원인을 로그에 남기고, 응답에는 내부 정보를 흘리지 않는다
      logger.error("http.unhandled", { ...base, durationMs: Date.now() - startedAt, error });
      return NextResponse.json(
        { error: "요청을 처리하지 못했습니다", request_id: requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}

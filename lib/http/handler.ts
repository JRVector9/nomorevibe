import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { adminIngressAllowed, isAdminProtectedPath } from "@/lib/auth/admin-access";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { runWebWrite, WEB_FENCED_RETRY_AFTER } from "@/lib/operations/dr/web-gate";

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
/** 이 밖의 메서드는 쓰기다 — fenced DB 에서는 handler 전에 거절하고, 쓰기 TX 마다 fence 를 첫 lock 으로 둔다(web-gate) */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** DB 에 쓰지 않는 쓰기 메서드(쿠키만 지우는 관리자 로그아웃) — fence·DB 를 거치지 않는다. DB 에 쓰는 route 에 주지 않는다 */
export type RouteOptions = { dbWrite?: false };

/** 관리자 경로는 비관리자 ingress 에 fence·DB 상태(503·500)를 드러내지 않는다 — proxy 와 같은 판정으로 404 가 먼저다 */
function adminIngressRefused(req: Request): boolean {
  return isAdminProtectedPath(new URL(req.url).pathname) && !adminIngressAllowed(req.headers);
}

export function withRoute<C extends RouteContext = RouteContext>(
  name: string,
  handler: (req: Request, ctx: C) => Promise<Response>,
  options: RouteOptions = {},
): Handler<C> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const base = { requestId, route: name, method: req.method };

    try {
      const res = SAFE_METHODS.has(req.method) || options.dbWrite === false ? await handler(req, ctx)
        : adminIngressRefused(req) ? new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } })
        : await runWebWrite(() => handler(req, ctx));
      const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
      logger[level]("http.request", { ...base, status: res.status, durationMs: Date.now() - startedAt });
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (error) {
      if (error instanceof HttpOriginPermitError) {
        logger.info("http.deferred", { ...base, status: 503, durationMs: Date.now() - startedAt });
        return NextResponse.json(
          { error: "잠시 이용할 수 없습니다. 잠시 후 다시 시도해주세요.", request_id: requestId },
          { status: 503, headers: { "x-request-id": requestId } },
        );
      }
      if (error instanceof DrWriterFencedError) {
        logger.warn("http.writer_fenced", { ...base, status: 503, reason: error.reason, durationMs: Date.now() - startedAt });
        return NextResponse.json(
          { error: "잠시 이용할 수 없습니다. 잠시 후 다시 시도해주세요.", request_id: requestId },
          { status: 503, headers: { "x-request-id": requestId, "Retry-After": WEB_FENCED_RETRY_AFTER } },
        );
      }
      // 처리되지 않은 예외 — 원인을 로그에 남기고, 응답에는 내부 정보를 흘리지 않는다
      logger.error("http.unhandled", { ...base, durationMs: Date.now() - startedAt, error });
      return NextResponse.json(
        { error: "요청을 처리하지 못했습니다", request_id: requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}

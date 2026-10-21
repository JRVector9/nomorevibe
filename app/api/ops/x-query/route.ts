import { verifiedWebWriteRoute } from "@/lib/operations/dr/web-gate";
import { serveXQuery, verifyXQueryRequest, xQueryUnavailable } from "@/lib/operations/x-query-receive";

/**
 * X 수집기(osaka-smoke)가 그날 검색할 우리 제품 저장소를 묻는 주소 — 서명한 POST(2026-10-21).
 *
 * 하루 보고(/api/ops/x-status)와 같은 비밀(X_STATUS_REPORT_SECRET)을 쓰고 서명 머리만 다르다. 비밀이 없으면 404 이고 DB 를 보지 않는다.
 * 답은 공개 제품의 저장소 이름(소문자 owner/repo)뿐이다. 관측 표의 x-query 한 줄에 돌아가는 차례를 적으므로 쓰기 관문을 지난다.
 * 묻는 쪽: lib/social/x-report.ts 의 requestXQuery. 계약: lib/operations/x-query.ts
 */
export const POST = verifiedWebWriteRoute((request: Request) => verifyXQueryRequest(request), serveXQuery, xQueryUnavailable);

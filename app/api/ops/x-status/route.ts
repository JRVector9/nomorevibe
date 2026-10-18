import { verifiedWebWriteRoute } from "@/lib/operations/dr/web-gate";
import { verifyXStatusRequest, writeXStatus, xStatusUnavailable } from "@/lib/operations/x-status-receive";

/**
 * X 수집기(osaka-smoke)의 하루 보고 — 서명한 push 를 받는 공개 쓰기 주소 하나(운영센터 v8 PR9).
 *
 * 받는 웹에 X_STATUS_REPORT_SECRET 이 없으면 404 이고 DB 를 보지 않는다. 검사는 크기 → 시각 → 서명 → 형식까지 DB 없이 하고,
 * 그 뒤에야 DR 관문 → 단조 → 속도 → x-status 한 줄 쓰기다. 보내는 쪽 계약: docs/operations/2026-10-18-x-status-report-runbook.md
 */
export const POST = verifiedWebWriteRoute((request: Request) => verifyXStatusRequest(request), writeXStatus, xStatusUnavailable);

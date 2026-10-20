import { verifiedWebWriteRoute } from "@/lib/operations/dr/web-gate";
import { verifyXPostsRequest, writeXPosts, xPostsUnavailable } from "@/lib/operations/x-posts-receive";

/**
 * X 수집기(osaka-smoke)의 게시물 관측 — 서명한 push 를 받는 공개 쓰기 주소(SNS 화제 C안 T18).
 *
 * 하루 보고(/api/ops/x-status)와 같은 비밀(X_STATUS_REPORT_SECRET)을 쓰고 서명 머리만 다르다. 비밀이 없으면 404 이고 DB 를 보지 않는다.
 * 받은 게시물은 social_posts(source=x)에 ID·저장소·반응 수만 남는다. 보내는 쪽: lib/social/x-report.ts
 */
export const POST = verifiedWebWriteRoute((request: Request) => verifyXPostsRequest(request), writeXPosts, xPostsUnavailable);

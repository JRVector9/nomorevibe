/**
 * 크롤러 활동이 아는 수집기 이벤트와 필드 — 화면(lib/operations/crawler-activity.ts)이 보이고, 회차 누적(lib/jobs/tally.ts)이
 * 지표 상한(한 틱 48개) 안에서 먼저 싣는다. 여기 없는 이벤트·필드(임의 로그 글자·번호)는 브라우저로 가지 않는다.
 *
 * - fields: 이 이벤트가 싣는 숫자(마지막 회차에 그대로, 누적에는 더해서 뜻이 있는 것만)
 * - noSum: 누적에서 빼는 필드 — 매번 같은 창을 다시 세는 수(예: HN 화제의 72시간 found·observed)는 더하면 부풀어 보인다
 * - foldInto: 누적에서 이 필드를 다른 이벤트의 같은 필드에 더한다(한도 대기로 끝난 회차의 원본 확보를 «원본 수집 결과»에 더한다)
 */
export type CollectorEventDefinition = { label: string; fields: string[]; error?: boolean; waiting?: boolean;
  noSum?: string[]; foldInto?: { event: string; fields: string[] } };

export const COLLECTOR_EVENTS: Record<string, CollectorEventDefinition> = {
  "crawl.seeded": { label: "탐색 결과", fields: ["discovered", "drained", "page", "incompleteWindows"] },
  "crawl.seed_latest_scanned": { label: "최신 탐색 결과", fields: ["discovered", "page", "incompleteWindows"] },
  "crawl.seed_admission": { label: "탐색 수용 확인", fields: ["throttled"] },
  "crawl.seed_failed": { label: "탐색 항목 오류", fields: [], error: true },
  "crawl.seed_incomplete": { label: "탐색 이어서 처리", fields: ["page"], waiting: true },
  "crawl.fetched": { label: "원본 수집 결과", fields: ["fetched", "skipped", "failed", "gated", "drained"] },
  "crawl.fetch_recovered": { label: "중단 수집 회수", fields: ["recovered"] },
  // 한도·인증 대기로 끝난 회차는 crawl.fetched 대신 이것만 남기고, 그때까지 확보한 수(fetched)를 싣는다(lib/crawl/jobs/fetch.ts)
  "crawl.fetch_rate_limited": { label: "원본 공급자 한도 대기", fields: ["fetched"], waiting: true, foldInto: { event: "crawl.fetched", fields: ["fetched"] } },
  "crawl.fetch_auth_unavailable": { label: "원본 수집 인증 확인 필요", fields: ["fetched"], error: true, foldInto: { event: "crawl.fetched", fields: ["fetched"] } },
  "crawl.show_hn_seeded": { label: "Show HN 수집 결과", fields: ["discovered", "examined", "backlogPages", "drained"] },
  "crawl.show_hn_failed": { label: "Show HN 항목 오류", fields: ["page"], error: true },
  // found·observed·unlinked·skipped 는 30분마다 최근 72시간 창을 다시 센 수다 — 누적에 더하지 않는다
  // unlinked: 저장소 키 없이 남긴 글(github.io·gist 등), skipped: 주소·제목이 없어 버린 글
  "social.hn_talk_collected": { label: "HN 화제 수집 결과", fields: ["found", "unlinked", "skipped", "inserted", "updated", "observed", "missing", "gone", "expired", "complete"],
    noSum: ["found", "observed", "unlinked", "skipped"] },
  "social.hn_talk_failed": { label: "HN 화제 검색 오류", fields: ["page"], error: true },
  "social.hn_talk_lookup_failed": { label: "HN 화제 다시 묻기 오류", fields: [], error: true },
  // Bluesky: found·unlinked·multi·skipped·observed·missing·heavy 는 회차마다 같은 창을 다시 센 수다 — 누적에 더하지 않는다
  // unlinked: 저장소 키 없이 읽은 글, multi: 저장소 여럿(attributed: 그중 공개 제품 저장소에 붙인 글), held·bots: 라벨·봇으로 숨긴 글,
  // gone: 다시 물어 없던 글, purged: 내린 지 7일 지나 행째 지운 글
  "social.bluesky_talk_collected": { label: "Bluesky 화제 수집 결과",
    fields: ["found", "unlinked", "multi", "attributed", "skipped", "inserted", "updated", "observed", "held", "released", "heavy", "bots", "missing", "rechecked", "gone", "expired", "purged", "requests", "complete", "truncated"],
    noSum: ["found", "unlinked", "multi", "attributed", "skipped", "observed", "missing", "heavy"] },
  "social.bluesky_talk_failed": { label: "Bluesky 화제 검색 오류", fields: ["page"], error: true },
  "social.bluesky_talk_lookup_failed": { label: "Bluesky 화제 다시 묻기 오류", fields: [], error: true },
  "evidence.refresh_batch": { label: "공개 근거 수집 결과", fields: ["attempted", "succeeded", "failed", "factsChanged", "eventsInserted", "mediaInserted"] },
  "evidence.product_refresh_failed": { label: "공개 근거 항목 오류", fields: [], error: true },
  "evidence.initial_refresh_queue_failed": { label: "근거 수집 요청 오류", fields: [], error: true },
  "agent_evidence.scanned": { label: "개발 AI 조사 결과", fields: ["observations", "cached", "failed"] },
  "agent_evidence.failed": { label: "개발 AI 조사 오류", fields: [], error: true },
  "agent_evidence.attach_failed": { label: "개발 AI 근거 연결 오류", fields: [], error: true },
  "agent_evidence.deferred": { label: "개발 AI 조사 재시도 대기", fields: [], waiting: true },
  "agent_evidence.disabled": { label: "개발 AI 수집 설정 꺼짐", fields: [] },
  "agent_evidence.github_headroom_low": { label: "개발 AI 조사 GitHub 잔량 부족", fields: ["remaining", "limit"], waiting: true },
  // items 모드 컨트롤러 틱(GitHub 호출 없음) — 스캔은 consumer 가 맡는다
  "agent_scan.queue_filled": { label: "개발 AI 조사 대기열 채우기", fields: ["upserted", "gone"] },
  "agent_scan.admin_consumed": { label: "관리자 추가 수집 완료 처리", fields: ["consumed"] },
  "ai_level.tick": { label: "AI 단계 확인 결과", fields: ["checked", "due", "verified", "restUsed"] },
  "ai_level.rate_limited": { label: "AI 단계 공급자 한도 대기", fields: [], waiting: true },
  "ai_level.graphql_low": { label: "AI 단계 공급자 잔량 부족", fields: ["remaining"], waiting: true },
  "product_stars.refreshed": { label: "저장소·스타 확인 결과", fields: ["examined", "updated", "ok", "missing", "empty", "blocked", "unknown", "renamed", "archived", "batches", "failed"] },
  "product_stars.waiting": { label: "저장소·스타 공급자 대기", fields: ["examined", "updated", "batches"], waiting: true },
  "product_star_observation.closed": { label: "스타 관측 회차 닫힘", fields: ["runs"] },
  "product_star_observation.collected": { label: "스타 관측 결과", fields: ["examined", "recorded", "batches", "targets"] },
  "product_star_observation.waiting": { label: "스타 관측 공급자 대기", fields: ["examined", "recorded", "batches"], waiting: true },
  "readme_refresh.done": { label: "README 갱신 결과", fields: ["refreshed", "failed", "superseded"] },
  "uptime.idle": { label: "응답 점검 대상 없음", fields: ["checked"] },
  "uptime.checked": { label: "서비스 응답 결과", fields: ["alive", "down", "unknown"] },
  "uptime.broad_failure_held": { label: "응답 점검 광역 실패 보류", fields: ["attempted", "down", "unknown"], error: true },
  // split claims 모드(0104): 제출분(Oracle 등) 반영, home claim 이 멈춘 까닭(차단기 열림·policy 에 없는 instance·fenced)
  "uptime.split_applied": { label: "응답 점검 제출분 반영", fields: ["remote", "applied", "held", "confirmRequested", "returned", "stale", "lost"] },
  "uptime.split_blocked": { label: "응답 점검 분담 확인 멈춤", fields: ["breakerOpen", "unconfigured", "fenced"], error: true },
  "uptime.split_result_invalid": { label: "응답 점검 결과 모양 오류", fields: ["invalid"], error: true },
  "uptime.split_clock_skew": { label: "응답 점검 시계 어긋남(확인 쉼)", fields: ["skewMs"], error: true },
  "news.refreshed": { label: "소식 수집 결과", fields: ["added", "failed", "autoApprove", "unfinished"] },
  "thumbnail.refreshed": { label: "이미지 수집 결과", fields: ["examined", "filled", "defaults", "skipped", "failed"] },
  "repo_review.idle": { label: "저장소 재확인 대상 없음", fields: ["reviewed"] },
  "repo_review.reviewed": { label: "저장소 재확인 결과", fields: ["keep", "human", "delist_candidate", "delisted", "unknown", "capped", "operatorKeep"] },
  "repo_review.blocked": { label: "저장소 재확인 공급자 대기", fields: ["keep", "human", "delist_candidate", "delisted", "unknown", "capped", "operatorKeep"], waiting: true },
  "repo_review.capped": { label: "자동 내리기 한도 대기", fields: ["limit", "capped"], waiting: true },
};

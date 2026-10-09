/**
 * 작업 로그의 작업 이름 → 사람이 읽는 말, 그리고 거르기 갈래.
 * 목록에 없는 이름(스크립트가 남긴 옛 작업 등)은 이름 그대로 "기타"에 둔다.
 */
export const ACTION_LABELS: Record<string, string> = {
  "candidate-approve": "후보 승인",
  "candidate-reject": "후보 거부",
  "candidate-undo": "후보 결정 되돌리기",
  "evidence-collect": "근거 더 모으기",
  "requeue-resolved": "보류 되돌리기",
  "review-mode": "발행 관문 모드",
  "published-second-ban": "2차가 짚은 공개분 내림",
  "published-second-keep": "2차가 짚은 공개분 둠",
  "manual-category": "분류 직접 지정",
  "takedown-remove": "요청으로 내림",
  "takedown-dismiss": "요청을 두기",
  "audit-remove": "감사 거절 내림",
  "audit-keep": "감사 거절 둠",
  "audit-start": "감사 시작",
  "audit-cancel": "감사 중단",
  "product-ban": "제품 차단",
  "product-unban": "제품 차단 해제",
  "intro-keep": "소개 그대로 둠",
  "intro-edit": "소개 고침",
  "repo-review-delist": "저장소 사라진 사이트 내림",
  "repo-review-keep": "저장소 사라진 사이트 둠",
  "claim-invite": "클레임 초대 표시",
  "product-refresh": "제품 근거 갱신",
  "update-hide": "자동 업데이트 숨김",
  "update-restore": "자동 업데이트 복원",
  "settings-save": "설정 저장",
  "collection-enabled": "수집 켜기·끄기",
  "attention-ack": "조치 확인함·숨김",
  "attention-unack": "조치 다시 보이기",
  "evidence-settings": "근거 설정 저장",
  "ranking-schedule": "랭킹 정책 예약",
  "ranking-cancel": "랭킹 정책 취소",
  "news-approve": "소식 게시",
  "news-hide": "소식 숨김",
  "request-job": "작업 실행 요청",
  "github-collector-token-save": "수집 토큰 저장",
  "github-collector-enable": "수집 계정 켜기",
  "github-collector-disable": "수집 계정 끄기",
  "ai-connect": "AI 연결",
  "ai-input": "AI 연결 코드 입력",
  "ai-cancel": "AI 연결 취소",
  "ai-probe": "AI 모델 조회",
  "ai-test": "AI 모델 시험",
  "ai-apply": "AI 모델 적용",
  "export": "목록 내보내기",
  "operator-name": "내 이름 적기",
  // 스크립트·잡이 남기는 작업(.crawl-samples·scripts·lib/crawl) — 화면에는 "스크립트" 배지와 함께 보인다
  "requeue-evidence-gated": "근거 관문에 막힌 후보 다시 판정",
  "requeue-rejected-under-new-policy": "새 기준으로 거부분 다시 판정",
  "requeue-rejected-under-held-rules": "보류 규칙으로 거부분 다시 판정",
  "reconsider-installable": "설치형 거부분 다시 판정",
  "reconsider-star-auto": "별 기준 자동 승인 다시 판정",
  "reconsider-package": "패키지 증거로 다시 판정",
  "reconcile-crawl-duplicate": "중복 후보 정리",
  "relabel-repo-deleted": "저장소 삭제로 다시 분류",
  "ban-spam-campaign": "스팸 캠페인 일괄 차단",
  "normalize-product-names": "제품 이름 일괄 정리",
  "revert-product-names": "제품 이름 정리 되돌리기",
  "retry-exhausted-transport-once": "수집 실패 한 번 더 시도",
  "resume-after-github-redirect-fix": "이름 바뀐 저장소 수집 재개",
};

/**
 * 대상 칸의 테이블 이름·접두어 → 사람이 읽는 말. 제품(slug)·저장소(owner/repo)·작업 이름은 그대로 둔다.
 * 테이블 이름이 대상인 줄은 여러 건을 한 번에 바꾼 줄이다 — 건수는 내용 요약이 말한다.
 */
export const TARGET_LABELS: Record<string, string> = {
  crawl_candidates: "수집 후보 여러 건",
  crawl_frontier: "수집 대기열",
  products: "제품 여러 건",
  crawl_settings: "크롤 설정",
  evidence_settings: "근거 설정",
  ranking_policy: "랭킹 정책",
  product_audit: "발행분 감사",
  "connect-agent": "AI 연결 도우미",
  "local-session": "이 브라우저",
};
const TARGET_PREFIXES: [RegExp, (rest: string) => string][] = [
  [/^campaign:(\d+)$/, (id) => `감사 #${id}`],
  [/^news:(\d+)$/, (id) => `소식 #${id}`],
  [/^news:(\d+)건$/, (count) => `소식 ${count}건`],
  [/^revision:(\d+)$/, (id) => `랭킹 정책 #${id}`],
  [/^export:(\w+)$/, (view) => `내보내기 · ${EXPORT_VIEW_NAMES[view] ?? view}`],
];
const EXPORT_VIEW_NAMES: Record<string, string> = { products: "제품", review: "심사 큐", audit: "감사 거절", activity: "작업 로그", news: "AI 소식" };

/** 대상 표기. 바꿔 적었으면 entity 가 false — 제품·저장소처럼 "이 대상의 기록"으로 거를 수 있는 것만 true */
export function targetLabel(target: string): { text: string; entity: boolean } {
  if (Object.hasOwn(TARGET_LABELS, target)) return { text: TARGET_LABELS[target], entity: false };
  for (const [pattern, label] of TARGET_PREFIXES) {
    const match = target.match(pattern);
    if (match) return { text: label(match[1]), entity: false };
  }
  return { text: target, entity: true };
}

export const ACTION_GROUPS = {
  takedown: { label: "내리기·차단", actions: ["takedown-remove", "takedown-dismiss", "audit-remove", "audit-keep", "audit-start", "audit-cancel",
    "product-ban", "product-unban", "published-second-ban", "published-second-keep", "repo-review-delist", "repo-review-keep", "ban-spam-campaign"] },
  review: { label: "심사", actions: ["candidate-approve", "candidate-reject", "candidate-undo", "evidence-collect", "requeue-resolved", "manual-category",
    "requeue-evidence-gated", "requeue-rejected-under-new-policy", "requeue-rejected-under-held-rules", "reconsider-installable",
    "reconsider-star-auto", "reconsider-package", "reconcile-crawl-duplicate", "relabel-repo-deleted"] },
  settings: { label: "설정·연결", actions: ["settings-save", "collection-enabled", "attention-ack", "attention-unack", "review-mode", "evidence-settings", "ranking-schedule", "ranking-cancel",
    "github-collector-token-save", "github-collector-enable", "github-collector-disable",
    "ai-connect", "ai-input", "ai-cancel", "ai-probe", "ai-test", "ai-apply"] },
  content: { label: "제품·소식·작업", actions: ["claim-invite", "intro-keep", "intro-edit", "product-refresh", "update-hide", "update-restore", "news-approve", "news-hide", "request-job",
    "retry-exhausted-transport-once", "resume-after-github-redirect-fix", "export", "operator-name",
    "normalize-product-names", "revert-product-names"] },
} as const;
export type ActionGroup = keyof typeof ACTION_GROUPS;

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

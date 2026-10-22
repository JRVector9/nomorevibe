/**
 * 작업 로그의 작업 이름 → 사람이 읽는 말, 그리고 거르기 갈래.
 * 목록에 없는 이름(스크립트가 남긴 옛 작업 등)은 이름 그대로 "기타"에 둔다.
 */
export const ACTION_LABELS: Record<string, string> = {
  "candidate-approve": "후보 승인",
  "candidate-deepseek-decision": "DeepSeek 위임 판단",
  "candidate-qwen-held-review": "Qwen-v2 보류 재심사",
  "held-qwen-retry-settings": "Qwen-v2 보류 재심사 설정",
  "qwen-auto-settings": "Qwen-v2 자동 단계 설정",
  "split-tiebreak-settings": "갈림 판가름 설정",
  "candidate-split-tiebreak-reject": "Qwen-v2 갈림 판가름 거부",
  "audit-hold-auto-release": "Qwen-v2 의견으로 감사 보류 풂",
  "audit-auto-keep": "Qwen-v2 의견으로 감사 거절 자동 유지",
  "audit-auto-hold": "Qwen-v2 의견으로 감사 거절 자동 숨김",
  "audit-auto-split": "Qwen-v2 와 다른 모델이 엇갈려 감사 거절을 열어 둠",
  "published-second-auto-keep": "Qwen-v2 공개분 자동 유지",
  "human-review-deepseek": "DeepSeek 사람 검토 전환",
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
  "audit-hold-settings": "감사 보류 설정",
  "audit-hold-release-all": "감사 보류 모두 풀기",
  "audit-switch-model": "남은 감사 모델 바꿈",
  "audit-policy-apply": "감사 정책 적용",
  "audit-policy-undo": "감사 정책 되돌림",
  "product-ban": "제품 차단",
  "product-auto-ban-uptime": "접속 실패 자동 내림",
  "product-unban": "제품 차단 해제",
  "intro-keep": "소개 그대로 둠",
  "intro-edit": "소개 고침",
  "intro-request-edit": "소개 수정 요청으로 고침",
  "intro-request-fixed": "소개 수정 요청 처리함",
  "intro-request-dismissed": "소개 수정 요청 둠",
  "repo-review-delist": "저장소 사라진 사이트 내림",
  "repo-review-keep": "저장소 사라진 사이트 둠",
  "claim-invite": "클레임 초대 표시",
  "product-refresh": "제품 근거 갱신",
  "update-hide": "자동 업데이트 숨김",
  "update-restore": "자동 업데이트 복원",
  "settings-save": "설정 저장",
  "collection-enabled": "수집 켜기·끄기",
  "source-buffer": "원본 공급 조절 켜기·끄기",
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
  "github-collector-app-save": "수집 App 저장",
  "github-collector-app-enable": "수집 App 켜기",
  "github-collector-app-disable": "수집 App 끄기",
  "ai-connect": "AI 연결",
  "ai-input": "AI 연결 코드 입력",
  "ai-cancel": "AI 연결 취소",
  "ai-probe": "AI 모델 조회",
  "ai-test": "AI 모델 시험",
  "ai-apply": "AI 모델 적용",
  "export": "목록 내보내기",
  "operator-name": "내 이름 적기",
  // 검수·재요청 화면(피드백 검수·써봤어요 검수·공개 번역)과 SNS 화제 — 전에는 이름이 없어 코드 그대로 어느 갈래에도 들지 않았다
  "feedback.review": "피드백 검수",
  "maker_reply.review": "메이커 답장 검수",
  "contact_request.create": "문의 수동 접수",
  "contact_request.update": "문의 처리",
  "reaction.comment_review": "써봤어요 한 줄 검수",
  "product-translation-retry": "공개 번역 재요청",
  "talk-post-hide": "SNS 글 숨김",
  "talk-post-show": "SNS 글 다시 보이기",
  "talk-repository-exclude": "저장소를 화제에서 뺌",
  "talk-repository-include": "저장소를 화제에 되돌림",
  "talk-home-approved": "홈 1위 허용",
  "talk-home-talk_only": "홈 대신 /talk 에만",
  "talk-home-clear": "홈 1위 결정 거둠(정하지 않음)",
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
  [/^policy-run:(\d+)$/, (id) => `감사 정책 #${id}`],
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
    "audit-hold-settings", "audit-hold-release-all", "audit-switch-model", "audit-hold-auto-release", "audit-auto-keep", "audit-auto-hold", "audit-auto-split",
    "published-second-auto-keep",
    "audit-policy-apply", "audit-policy-undo",
    "product-ban", "product-auto-ban-uptime", "product-unban", "published-second-ban", "published-second-keep", "repo-review-delist", "repo-review-keep", "ban-spam-campaign"] },
  review: { label: "심사", actions: ["candidate-approve", "candidate-reject", "candidate-deepseek-decision", "candidate-qwen-held-review", "candidate-split-tiebreak-reject", "candidate-undo", "evidence-collect", "requeue-resolved", "manual-category",
    "requeue-evidence-gated", "requeue-rejected-under-new-policy", "requeue-rejected-under-held-rules", "reconsider-installable",
    "reconsider-star-auto", "reconsider-package", "reconcile-crawl-duplicate", "relabel-repo-deleted"] },
  settings: { label: "설정·연결", actions: ["settings-save", "human-review-deepseek", "held-qwen-retry-settings", "qwen-auto-settings", "split-tiebreak-settings", "collection-enabled", "source-buffer", "attention-ack", "attention-unack", "review-mode", "evidence-settings", "ranking-schedule", "ranking-cancel",
    "github-collector-token-save", "github-collector-enable", "github-collector-disable",
    "github-collector-app-save", "github-collector-app-enable", "github-collector-app-disable",
    "ai-connect", "ai-input", "ai-cancel", "ai-probe", "ai-test", "ai-apply"] },
  content: { label: "제품·소식·작업", actions: ["claim-invite", "intro-keep", "intro-edit", "intro-request-edit", "intro-request-fixed", "intro-request-dismissed", "product-refresh", "update-hide", "update-restore", "news-approve", "news-hide", "request-job",
    "retry-exhausted-transport-once", "resume-after-github-redirect-fix", "export", "operator-name",
    "normalize-product-names", "revert-product-names",
    "feedback.review", "maker_reply.review", "contact_request.create", "contact_request.update", "reaction.comment_review", "product-translation-retry",
    "talk-post-hide", "talk-post-show", "talk-repository-exclude", "talk-repository-include", "talk-home-approved", "talk-home-talk_only", "talk-home-clear"] },
} as const;
export type ActionGroup = keyof typeof ACTION_GROUPS;

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

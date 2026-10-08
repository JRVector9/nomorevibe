/**
 * 작업 로그의 작업 이름 → 사람이 읽는 말, 그리고 거르기 갈래.
 * 목록에 없는 이름(스크립트가 남긴 옛 작업 등)은 이름 그대로 "기타"에 둔다.
 */
export const ACTION_LABELS: Record<string, string> = {
  "candidate-approve": "후보 승인",
  "candidate-reject": "후보 거부",
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
  "repo-review-delist": "저장소 사라진 사이트 내림",
  "repo-review-keep": "저장소 사라진 사이트 둠",
  "claim-invite": "클레임 초대 표시",
  "product-refresh": "제품 근거 갱신",
  "update-hide": "자동 업데이트 숨김",
  "update-restore": "자동 업데이트 복원",
  "settings-save": "설정 저장",
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
};

export const ACTION_GROUPS = {
  takedown: { label: "내리기·차단", actions: ["takedown-remove", "takedown-dismiss", "audit-remove", "audit-keep", "audit-start", "audit-cancel",
    "product-ban", "product-unban", "published-second-ban", "published-second-keep", "repo-review-delist", "repo-review-keep"] },
  review: { label: "심사", actions: ["candidate-approve", "candidate-reject", "evidence-collect", "requeue-resolved", "manual-category"] },
  settings: { label: "설정·연결", actions: ["settings-save", "review-mode", "evidence-settings", "ranking-schedule", "ranking-cancel",
    "github-collector-token-save", "github-collector-enable", "github-collector-disable",
    "ai-connect", "ai-input", "ai-cancel", "ai-probe", "ai-test", "ai-apply"] },
  content: { label: "제품·소식·작업", actions: ["claim-invite", "product-refresh", "update-hide", "update-restore", "news-approve", "news-hide", "request-job"] },
} as const;
export type ActionGroup = keyof typeof ACTION_GROUPS;

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

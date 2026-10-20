/** 마이페이지(/me) 문구 — 탭마다 구획을 나눠 둔다. 구획 이름은 시안의 PR 번호(MY1~MY8) */
export const me = {
  // 틀·머리·탭 (MY1)
  "page.title": "마이페이지",
  "page.description": "저장한 프로젝트, 써본 기록, 남긴 의견, 팔로 소식, 알림, 계정 설정을 한곳에서 봅니다.",
  "tabs.label": "마이페이지 탭",
  "tabs.projects": "내 프로젝트",
  "tabs.saved": "저장",
  "tabs.tried": "써봤어요",
  "tabs.opinions": "의견",
  "tabs.following": "팔로",
  "tabs.alerts": "알림",
  "tabs.account": "계정",
  "placeholder": "이 탭은 준비하고 있어요.",
  "loginRequired.body": "이 탭은 로그인하면 볼 수 있어요. 둘러보기와 저장은 로그인 없이도 돼요.",
  "loginRequired.cta": "로그인",
  // 계정 탭 (MY1)
  "account.title": "계정",
  // 의견 탭 (MY1)
  "opinions.title": "남긴 의견",
  // 저장 탭 (MY2)
  "saved.title": "저장한 프로젝트",
  // 써봤어요 탭·상세 평가 (MY3)
  "tried.title": "써본 프로젝트",
  // 팔로 탭 (MY4)
  "following.title": "팔로 중",
  // 알림 탭 (MY4)
  "alerts.title": "알림함",
  // 알림 설정 (MY7)
  "alertSettings.title": "알림 설정",
  // 내 프로젝트 탭 (MY5·MY6)
  "projects.title": "내 프로젝트",
  // 배지·공유 카드 (MY8)
  "share.title": "배지·공유 카드",
} as const;

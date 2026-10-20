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
  "saved.filterLabel": "저장 거르기",
  "saved.filter.all": "전체",
  "saved.filter.untried": "아직 안 써봄",
  "saved.categoryLabel": "분야로 거르기",
  "saved.sortLabel": "정렬",
  "saved.sort.recent": "저장한 순",
  "saved.sort.stars": "스타 많은 순",
  "saved.sort.activity": "최근 활동 순",
  "saved.synced": "휴대폰과 PC에서 같은 목록이에요.",
  "saved.untried": "아직 안 써봄",
  "saved.tried": "써봤어요",
  "saved.savedOn": "{date} 저장",
  "saved.removed": "{name} 저장을 뺐어요.",
  "saved.undo": "되돌리기",
  "saved.more": "{count}개 더 보기",
  "saved.loading": "불러오는 중…",
  "saved.error": "저장 목록을 불러오지 못했어요.",
  "saved.retry": "다시 시도",
  "saved.empty.title": "아직 저장한 프로젝트가 없어요",
  "saved.empty.body": "카드나 상세의 책갈피를 누르면 여기 모여요. 휴대폰과 PC에서 같은 목록으로 보여요.",
  "saved.empty.cta": "인기 프로젝트 둘러보기",
  "saved.empty.hint": "다른 브라우저에서 로그인 없이 저장해 둔 게 있다면, 그 브라우저에서 한 번 로그인하면 이리로 옮겨 와요.",
  "saved.filterEmpty": "이 조건에 맞는 저장이 없어요.",
  "saved.clearFilter": "모두 보기",
  "saved.browser.title": "이 브라우저에 있는 것",
  "saved.browser.count": "저장 {count}",
  "saved.browser.note": "로그인하면 옮길지 물어봐요",
  "saved.browser.emptyBody": "카드나 상세의 책갈피를 누르면 이 브라우저에 모여요.",
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

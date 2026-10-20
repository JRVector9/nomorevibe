import { defineCatalog } from "@/lib/i18n/messages";
import type { me as KoreanMe } from "@/messages/ko/me";

export const me = defineCatalog<typeof KoreanMe>()({
  // 틀·머리·탭 (MY1)
  "page.title": "My page",
  "page.description": "Your saved projects, tries, opinions, follows, alerts and account settings in one place.",
  "tabs.label": "My page tabs",
  "tabs.projects": "My projects",
  "tabs.saved": "Saved",
  "tabs.tried": "Tried",
  "tabs.opinions": "Opinions",
  "tabs.following": "Following",
  "tabs.alerts": "Alerts",
  "tabs.account": "Account",
  "placeholder": "This tab is on its way.",
  "loginRequired.body": "Sign in to see this tab. Browsing and saving work without an account.",
  "loginRequired.cta": "Sign in",
  // 계정 탭 (MY1)
  "account.title": "Account",
  // 의견 탭 (MY1)
  "opinions.title": "Your opinions",
  // 저장 탭 (MY2)
  "saved.title": "Saved projects",
  // 써봤어요 탭·상세 평가 (MY3)
  "tried.title": "Projects you tried",
  // 팔로 탭 (MY4)
  "following.title": "Following",
  // 알림 탭 (MY4)
  "alerts.title": "Inbox",
  // 알림 설정 (MY7)
  "alertSettings.title": "Alert settings",
  // 내 프로젝트 탭 (MY5·MY6)
  "projects.title": "My projects",
  // 배지·공유 카드 (MY8)
  "share.title": "Badge and share card",
});

import { defineCatalog } from "@/lib/i18n/messages";
import type { me as KoreanMe } from "@/messages/ko/me";

export const me = defineCatalog<typeof KoreanMe>()({
  // 틀·머리·탭 (MY1)
  "page.title": "我的页面",
  "page.description": "在一处查看收藏的项目、试用记录、留下的意见、关注动态、通知和账号设置。",
  "tabs.label": "我的页面标签",
  "tabs.projects": "我的项目",
  "tabs.saved": "收藏",
  "tabs.tried": "试用过",
  "tabs.opinions": "意见",
  "tabs.following": "关注",
  "tabs.alerts": "通知",
  "tabs.account": "账号",
  "placeholder": "此标签页正在准备中。",
  "loginRequired.body": "登录后即可查看此标签页。浏览和收藏无需登录。",
  "loginRequired.cta": "登录",
  // 계정 탭 (MY1)
  "account.title": "账号",
  // 의견 탭 (MY1)
  "opinions.title": "我的意见",
  // 저장 탭 (MY2)
  "saved.title": "收藏的项目",
  // 써봤어요 탭·상세 평가 (MY3)
  "tried.title": "试用过的项目",
  // 팔로 탭 (MY4)
  "following.title": "关注中",
  // 알림 탭 (MY4)
  "alerts.title": "通知箱",
  // 알림 설정 (MY7)
  "alertSettings.title": "通知设置",
  // 내 프로젝트 탭 (MY5·MY6)
  "projects.title": "我的项目",
  // 배지·공유 카드 (MY8)
  "share.title": "徽章与分享卡片",
});

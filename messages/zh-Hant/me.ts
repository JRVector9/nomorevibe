import { defineCatalog } from "@/lib/i18n/messages";
import type { me as KoreanMe } from "@/messages/ko/me";

export const me = defineCatalog<typeof KoreanMe>()({
  // 틀·머리·탭 (MY1)
  "page.title": "我的頁面",
  "page.description": "在一處查看收藏的專案、試用紀錄、留下的意見、追蹤動態、通知和帳號設定。",
  "tabs.label": "我的頁面分頁",
  "tabs.projects": "我的專案",
  "tabs.saved": "收藏",
  "tabs.tried": "試用過",
  "tabs.opinions": "意見",
  "tabs.following": "追蹤",
  "tabs.alerts": "通知",
  "tabs.account": "帳號",
  "placeholder": "此分頁正在準備中。",
  "loginRequired.body": "登入後即可查看此分頁。瀏覽和收藏無需登入。",
  "loginRequired.cta": "登入",
  // 계정 탭 (MY1)
  "account.title": "帳號",
  // 의견 탭 (MY1)
  "opinions.title": "我的意見",
  // 저장 탭 (MY2)
  "saved.title": "收藏的專案",
  // 써봤어요 탭·상세 평가 (MY3)
  "tried.title": "試用過的專案",
  // 팔로 탭 (MY4)
  "following.title": "追蹤中",
  // 알림 탭 (MY4)
  "alerts.title": "通知匣",
  // 알림 설정 (MY7)
  "alertSettings.title": "通知設定",
  // 내 프로젝트 탭 (MY5·MY6)
  "projects.title": "我的專案",
  // 배지·공유 카드 (MY8)
  "share.title": "徽章與分享卡片",
});

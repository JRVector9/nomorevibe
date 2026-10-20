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
  "saved.filterLabel": "篩選收藏",
  "saved.filter.all": "全部",
  "saved.filter.untried": "尚未試用",
  "saved.categoryLabel": "依分類篩選",
  "saved.sortLabel": "排序",
  "saved.sort.recent": "最近收藏",
  "saved.sort.stars": "星標最多",
  "saved.sort.activity": "最近活動",
  "saved.synced": "手機和電腦上是同一份清單。",
  "saved.untried": "尚未試用",
  "saved.tried": "試用過",
  "saved.savedOn": "{date} 收藏",
  "saved.removed": "已取消收藏：{name}",
  "saved.undo": "復原",
  "saved.more": "再顯示 {count} 個",
  "saved.loading": "載入中…",
  "saved.error": "無法載入收藏清單。",
  "saved.retry": "重試",
  "saved.empty.title": "還沒有收藏的專案",
  "saved.empty.body": "點卡片或詳情頁上的書籤即可收藏到這裡，手機和電腦上是同一份清單。",
  "saved.empty.cta": "瀏覽熱門專案",
  "saved.empty.hint": "如果在其他瀏覽器中未登入時收藏過，在那個瀏覽器登入一次即可移到這裡。",
  "saved.filterEmpty": "沒有符合此條件的收藏。",
  "saved.clearFilter": "查看全部",
  "saved.browser.title": "此瀏覽器中的收藏",
  "saved.browser.count": "收藏 {count}",
  "saved.browser.note": "登入後會詢問是否移到帳號",
  "saved.browser.emptyBody": "點卡片或詳情頁上的書籤，就會保存在此瀏覽器中。",
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

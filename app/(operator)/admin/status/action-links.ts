/**
 * 운영센터 "조치할 일"이 보내는 곳 — 한 곳에 모아 둔다.
 *
 * 전에는 주소를 줄마다 적어 없는 앵커(/admin#second-review)와 거르기 없는 목록(/admin/products)으로 보냈다
 * (2026-10-08 감사 ADM-03). tests/admin-status-action-links.test.ts 가 여기 있는 주소마다 경로·거르기·앵커·
 * 쿼리 값이 받는 화면에 실제로 있는지, page.tsx 가 여기 밖의 주소를 쓰지 않는지 본다.
 */

/** 운영센터 탭(?tab=) — 첫 화면이 overview. diagnostics(진단)는 옛 접힌 "상세 지표"(ADM-16) */
export const STATUS_TABS = ["overview", "jobs", "ai", "manual", "diagnostics"] as const;
export type StatusTab = typeof STATUS_TABS[number];

/** 작업 흐름 탭에서 그 작업의 상세 창을 연 채로 */
export const jobHref = (name: string) => `/admin/status?tab=jobs&job=${encodeURIComponent(name)}`;

const productFilter = (name: string) => `/admin/products?filter=${encodeURIComponent(name)}`;

export const ACTION_LINKS = {
  jobs: "/admin/status?tab=jobs",
  ai: "/admin/status?tab=ai",
  manual: "/admin/status?tab=manual",
  roles: "/admin/status#roles",
  models: "/admin/status#models",
  /** 직접 판단 구간, 오래 기다린 것부터 */
  reviewHuman: "/admin/review?stage=human&sort=wait#review-list",
  /** 확정만 하면 됨 — 두 모델이 같은 결론 */
  reviewAgreed: "/admin/review?stage=agreed#review-list",
  /** 2차가 다시 본 공개분 */
  reviewPublished: "/admin/review?second=published#review-list",
  /** 설정 화면의 2차 심사 칸(SettingsForm id="second") */
  secondSettings: "/admin#second",
  /** 설정 화면 머리의 워커별 적용 확인(SettingsApplyLine id="apply") */
  settingsApply: "/admin#apply",
  productsDown: productFilter("응답 없음"),
  productsIntro: productFilter("소개 확인 필요"),
  productsRepoGone: productFilter("저장소 사라짐"),
  productsSpamBanned: productFilter("스팸 자동 차단"),
  takedowns: "/admin/audit?tab=requests",
  audit: "/admin/audit",
  githubAccounts: "/admin/github-accounts",
} as const;

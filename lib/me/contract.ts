/**
 * 마이페이지(/me) 공통 약속 — 탭·주소, 써봤어요 평가 값, 팔로 대상, 알림 종류와 메일 설정 값.
 * 화면·API·표(drizzle/0108_mypage.sql)가 같은 값을 쓰도록 여기 한곳에 둔다(마이페이지 시안 2026-10-18, Q1–Q7 권장안).
 */

/** 탭 순서 = 모은 것 → 남긴 것 → 받는 소식 → 설정. 내 프로젝트는 확인한 프로젝트가 있거나 GitHub 로 로그인한 계정에만 맨 앞에 붙는다 */
export const ME_TABS = ["projects", "saved", "tried", "opinions", "following", "alerts", "account"] as const;
export type MeTab = (typeof ME_TABS)[number];
/**
 * 내 프로젝트 탭·메뉴를 보일까 — 확인한 메이커와, 아직 확인하지 않은 GitHub 계정(이미 등재된 내 저장소를 찾아 확인하는 곳이 그 탭뿐이다).
 * 탭 줄(MeTabs)과 아바타 메뉴(AccountMenu)가 같은 규칙을 쓴다
 */
export function showsProjectsTab(account: { isMaker: boolean; providers: readonly { provider: string }[] } | null | undefined): boolean {
  return Boolean(account && (account.isMaker || account.providers.some((item) => item.provider === "github")));
}
/** 각 탭 주소(로케일 앞붙이기 전). 저장이 /me 기본 탭이다(Q1) */
export const ME_TAB_PATHS: Record<MeTab, string> = {
  projects: "/me/projects",
  saved: "/me",
  tried: "/me/tried",
  opinions: "/me/opinions",
  following: "/me/following",
  alerts: "/me/alerts",
  account: "/me/account",
};
/** 저장 탭으로 바로 가는 주소 — 답장 기다림이 있는 메이커는 /me 가 내 프로젝트로 열리므로(Q3) 탭·메뉴의 «저장»은 이쪽 */
export const ME_SAVED_LINK = "/me?tab=saved";

/** 써봤어요 평가 — 좋았어요·그저 그래요·안 됐어요 */
export const REACTION_VERDICTS = ["good", "meh", "bad"] as const;
export type ReactionVerdict = (typeof REACTION_VERDICTS)[number];
/** 고정 태그 어휘(최대 4개). broken·suspicious 는 랭킹에서 감점·제외 후보 */
export const REACTION_TAGS = ["easy", "useful", "fast", "pretty", "korean", "free", "slow", "broken", "confusing", "suspicious"] as const;
export type ReactionTag = (typeof REACTION_TAGS)[number];
export const REACTION_TAG_LIMIT = 4;
export const REACTION_COMMENT_LIMIT = 140;
export const REACTION_SOURCES = ["panel", "return", "sheet", "me"] as const;
export type ReactionSource = (typeof REACTION_SOURCES)[number];
export type ReactionCommentState = "accepted" | "held" | "rejected";
/** 로그아웃 상태에서 이 브라우저가 평가한 제품 slug 목록(Q4) — localStorage, 최대 500개 */
export const BROWSER_REACTED_KEY = "nmb-reacted-v1";
export const BROWSER_LIST_LIMIT = 500;
/** 계정 저장 목록 상한(시안 MY2) */
export const SAVED_LIMIT = 500;

/** 팔로 대상 — 제품 id · GitHub 주인 숫자 id · 분야 slug */
export const FOLLOW_TARGETS = ["product", "maker", "category"] as const;
export type FollowTarget = (typeof FOLLOW_TARGETS)[number];

/** 알림 종류 — 로그인 설계 여섯 개 + category_new · maker_new_project · comment_reviewed(Q7) */
export const NOTIFICATION_KINDS = [
  "maker_reply", "followed_release", "followed_delisted", "maker_new_project", "category_new", "comment_reviewed", "new_listing_mine", "inbox_new",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** 알림은 90일 보관한다 */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** 메일 설정 — 사이트 안 알림함은 늘 켜져 있고, 메일만 고른다. 칸마다 고를 수 있는 값이 다르다 */
export type EmailMode = "instant" | "weekly" | "off";
export const EMAIL_SETTING_CHOICES = {
  makerReply: ["instant", "weekly", "off"],
  followedProject: ["instant", "weekly", "off"],
  followedMaker: ["instant", "weekly", "off"],
  followedCategory: ["weekly", "off"],
  newListingMine: ["instant", "off"],
} as const satisfies Record<string, readonly EmailMode[]>;
export type EmailSettingKey = keyof typeof EMAIL_SETTING_CHOICES;

/** 운영자 확인 방법·역할 */
export type MakerRole = "owner" | "editor";
export type MakerMethod = "github_repo_owner" | "github_repo_admin" | "repo_file" | "edit_token" | "admin";
export type MakerReplyTarget = "reaction" | "feedback";

/** 닉네임은 30일에 한 번 바꾼다 */
export const DISPLAY_NAME_CHANGE_DAYS = 30;

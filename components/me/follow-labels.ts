import type { Translator } from "@/lib/i18n/messages";
import type { FollowTarget } from "@/lib/me/contract";
import { FOLLOW_LIMIT } from "@/lib/me/follow-keys";

export type FollowLabels = {
  follow: string; following: string; aria: string; loginTitle: string; loginBody: string; login: string; later: string; failed: string; limit: string;
};

/** 로그인 권하는 글 — 팔로하면 받는 것이 종류마다 다르다(프로젝트: 릴리스·내려감, 메이커: 새 프로젝트, 분야: 주간 요약) */
const LOGIN_BODY = { product: "follow.loginBody", maker: "follow.loginBodyMaker", category: "follow.loginBodyCategory" } as const;

/** 팔로 단추의 글자 — 상세·분야 화면에는 사전 전체를 보내지 않고 단추가 쓰는 몇 줄만 넘긴다(엣지에 저장되는 화면이다) */
export function followLabels(t: Translator<"me">, target: FollowTarget, aria: string): FollowLabels {
  return { follow: t("follow.button"), following: t("follow.following"), aria, loginTitle: t("follow.loginTitle"), loginBody: t(LOGIN_BODY[target]),
    login: t("follow.login"), later: t("follow.later"), failed: t("follow.failed"), limit: t("follow.limit", { limit: FOLLOW_LIMIT }) };
}

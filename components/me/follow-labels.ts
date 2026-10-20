import type { Translator } from "@/lib/i18n/messages";
import { FOLLOW_LIMIT } from "@/lib/me/follow-keys";

export type FollowLabels = {
  follow: string; following: string; aria: string; loginTitle: string; loginBody: string; login: string; later: string; failed: string; limit: string;
};

/** 팔로 단추의 글자 — 상세·분야 화면에는 사전 전체를 보내지 않고 단추가 쓰는 몇 줄만 넘긴다(엣지에 저장되는 화면이다) */
export function followLabels(t: Translator<"me">, aria: string): FollowLabels {
  return { follow: t("follow.button"), following: t("follow.following"), aria, loginTitle: t("follow.loginTitle"), loginBody: t("follow.loginBody"),
    login: t("follow.login"), later: t("follow.later"), failed: t("follow.failed"), limit: t("follow.limit", { limit: FOLLOW_LIMIT }) };
}

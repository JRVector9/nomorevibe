import type { Product } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";

/**
 * 제품을 수정할 자격을 증명한 주체.
 *
 * 지금은 수정 키 하나뿐이지만 계정(GitHub 로그인)이 붙으면 경로가 둘이 된다.
 * 유스케이스가 "누구인지"가 아니라 "자격이 있는지"만 알게 해두면, 그때 여기에
 * 종류를 하나 추가하는 것으로 끝난다 — manage.ts는 손대지 않는다.
 */
export type Actor =
  | { kind: "edit_token" }
  | { kind: "admin" };
// 계정 도입 시: | { kind: "account"; userId: number }

export type Credentials = {
  editToken?: string | null;
  /** 계정 세션이 붙으면 여기에 추가된다 */
};

export type AuthOutcome =
  | { ok: true; actor: Actor }
  | { ok: false; reason: "missing" | "invalid" };

/** 자격 증명이 이 제품을 수정할 수 있는지 판정한다 (DB 접근 없음 — 순수 판정) */
export function authenticate(product: Product, credentials: Credentials): AuthOutcome {
  const { editToken } = credentials;
  if (!editToken) return { ok: false, reason: "missing" };
  if (hashToken(editToken) !== product.editTokenHash) return { ok: false, reason: "invalid" };
  return { ok: true, actor: { kind: "edit_token" } };
}

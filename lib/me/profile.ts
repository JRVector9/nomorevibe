import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { DISPLAY_NAME_CHANGE_DAYS } from "./contract";

/** 계정 탭 규칙 — 닉네임 모양·바꿀 수 있는 날·이메일 가리기·기기 줄 id. DB 를 보지 않는 함수만 둔다 */

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;
/** 탈퇴한 계정의 이름 — 아무도 이 이름으로 바꾸지 못한다 */
export const DELETED_DISPLAY_NAME = "탈퇴한 사용자";
// 운영자·서비스를 흉내 내는 이름은 막는다(대소문자·공백 무시)
const RESERVED = /nomorevibe|노모어바이브|관리자|운영자|admin/i;
// 제어·서식 문자(보이지 않는 글자, 방향 바꾸기)와 줄·문단 나눔
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;

/** 닉네임 — 앞뒤 공백을 떼고, 가운데 공백은 하나로. 2~24자, 보이지 않는 글자 없음 */
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.length > 200) throw new PublicAuthError(400, "invalid_display_name");
  const trimmed = value.normalize("NFC").trim();
  // 줄바꿈·탭도 제어 문자다 — 공백으로 바꾸지 않고 거절한다
  if (INVISIBLE.test(trimmed)) throw new PublicAuthError(400, "invalid_display_name");
  const name = trimmed.replace(/\s+/gu, " ");
  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) throw new PublicAuthError(400, "invalid_display_name");
  if (name === DELETED_DISPLAY_NAME || RESERVED.test(name.replace(/\s/g, ""))) throw new PublicAuthError(400, "reserved_display_name");
  return name;
}

/** 다음에 닉네임을 바꿀 수 있는 때. 아직 바꾼 적이 없거나 지났으면 null(지금 바꿀 수 있음) */
export function displayNameChangeAvailableAt(changedAt: Date | null, now: Date = new Date()): Date | null {
  if (!changedAt) return null;
  const next = new Date(changedAt.getTime() + DISPLAY_NAME_CHANGE_DAYS * 24 * 60 * 60 * 1000);
  return next > now ? next : null;
}

/** 이메일은 앞 두 글자와 도메인만 보인다 — "ha•••@example.com" */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = [...email.slice(0, at)];
  return `${local.slice(0, local.length > 2 ? 2 : 1).join("")}•••${email.slice(at)}`;
}

/** 기기 줄 id — 토큰 해시 앞 16자. 해시 전체는 화면·응답에 내보내지 않는다 */
export function sessionPublicId(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}

export function isSessionPublicId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

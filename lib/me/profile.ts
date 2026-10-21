import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { formatDay } from "@/lib/format/time";
import { DISPLAY_NAME_CHANGE_DAYS } from "./contract";

/** 계정 탭 규칙 — 닉네임 모양·바꿀 수 있는 날·이메일 가리기·기기 줄 id. DB 를 보지 않는 함수만 둔다 */

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;
/** 받는 글자의 상한(UTF-16) — 입력 칸도 같은 수까지 받고, 2~24자는 아래 정리를 한 뒤 코드 포인트로 센다 */
export const DISPLAY_NAME_INPUT_MAX = 200;
/** 탈퇴한 계정의 이름 — 아무도 이 이름으로 바꾸지 못한다 */
export const DELETED_DISPLAY_NAME = "탈퇴한 사용자";
/**
 * 탈퇴한 작성자를 화면이 적는 이름(me account.deletedName · detail feedback.deletedAuthor, 네 언어) — 산 계정이 같은 모양을 쓰지 못한다.
 * tests/me-account.test.ts 가 네 언어 사전의 글과 같은지 본다
 */
const DELETED_LABELS = [DELETED_DISPLAY_NAME, "Deleted user", "已注销用户", "已註銷使用者"];
// 운영자·서비스를 흉내 내는 이름은 막는다 — 호환 글자(전각 등)를 접고, 공백·문장 부호·기호를 빼고 본다
const RESERVED = /nomorevibe|노모어바이브|관리자|운영자/;
// admin 은 낱말의 앞이나 끝일 때만 — "badminton" 은 되고 "admin"·"사이트admin"·"superadmin"·"administrator" 는 안 된다
const RESERVED_ADMIN = /(?:^|[^a-z0-9])admin|admin(?:[^a-z0-9]|$)/;
// 제어·서식 문자(보이지 않는 글자, 방향 바꾸기)·줄·문단 나눔과, 기본으로 안 보이는 글자(한글 채움 문자 U+3164 등)·점자 빈칸.
// 이모지 뒤의 모양 고르기(U+FE0F 등)만 둔다
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u2800]|(?!\p{Variation_Selector})\p{Default_Ignorable_Code_Point}/u;
const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}\p{M}]/gu, "");
const DELETED_COMPACT = new Set(DELETED_LABELS.map(compact));

/** 화면(글자 수 칸)과 서버가 같게 세는 닉네임 모양 — NFC 로 맞추고 앞뒤 공백을 떼고, 가운데 공백은 하나로. 글자 수는 코드 포인트로 센다 */
export function displayNameDraft(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** 닉네임 — 앞뒤 공백을 떼고, 가운데 공백은 하나로. 2~24자, 보이지 않는 글자 없음, 보이는 글자로 시작 */
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.length > DISPLAY_NAME_INPUT_MAX) throw new PublicAuthError(400, "invalid_display_name");
  const trimmed = value.normalize("NFC").trim();
  // 줄바꿈·탭도 제어 문자다 — 공백으로 바꾸지 않고 거절한다. 호환 글자로 접으면 채움 문자가 되는 것(U+FFA0)도 본다
  if (INVISIBLE.test(trimmed) || INVISIBLE.test(trimmed.normalize("NFKC"))) throw new PublicAuthError(400, "invalid_display_name");
  const name = displayNameDraft(trimmed);
  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) throw new PublicAuthError(400, "invalid_display_name");
  // 결합 부호만 있거나 결합 부호로 시작하는 이름은 앞 글자에 붙어 비어 보인다
  if (/^\p{M}/u.test(name) || !/[^\s\p{M}]/u.test(name)) throw new PublicAuthError(400, "invalid_display_name");
  const key = compact(name);
  if (DELETED_COMPACT.has(key) || RESERVED.test(key) || RESERVED_ADMIN.test(name.normalize("NFKC").toLowerCase())) {
    throw new PublicAuthError(400, "reserved_display_name");
  }
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

/** 내 데이터 파일 이름 — 날짜는 사이트의 다른 날짜처럼 한국 날짜다(00:00~08:59 KST 에 받아도 그날) */
export function exportFileName(exportedAt: string): string {
  return `nomorevibe-my-data-${formatDay(exportedAt, "").replaceAll("-", "")}.json`;
}

/** 기기 줄 id — 토큰 해시 앞 16자. 해시 전체는 화면·응답에 내보내지 않는다 */
export function sessionPublicId(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}

export function isSessionPublicId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

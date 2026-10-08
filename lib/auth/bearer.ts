import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authorization 헤더가 `Bearer <비밀값>` 과 같은지.
 *
 * 문자열을 !== 로 견주면 앞에서부터 다른 글자를 만나는 순간 끝나, 응답 시간으로 비밀값을 한 글자씩
 * 맞춰 볼 수 있다. 두 쪽을 같은 길이의 해시로 바꿔 상수 시간으로 견준다 — 길이가 달라도 같은 경로를 탄다.
 * 비밀값이 비어 있으면 아무것도 통과시키지 않는다.
 */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || header === null) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

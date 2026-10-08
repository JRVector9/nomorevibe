import { createHash } from "node:crypto";

/**
 * 크롤 설정의 판 — 워커가 어느 판으로 도는지 설정 화면이 견주는 값(2026-10-08 UX 감사 ADM-19).
 *
 * 행에 판 번호 열이 없어(스키마를 바꾸지 않는다) 저장된 원본(jsonb)을 해시한다. 코드 기본값을 덮기 전의 값이라
 * 웹과 워커의 릴리스가 달라도 같은 행을 읽었으면 같은 판이다. 카테고리 기준(classify)·리뷰 모드도 같은 행이라 함께 바뀐다.
 *
 * DB 를 부르지 않는다 — 워커의 heartbeat(scripts/worker.ts)가 이 모듈만 불러 마지막으로 읽은 판을 싣는다.
 */
export function storedSettingsVersion(values: unknown): string {
  return createHash("sha256").update(JSON.stringify(values ?? null)).digest("hex").slice(0, 16);
}

/** 화면에 보일 짧은 판 이름 "v3f9a2c" — git 짧은 커밋처럼 앞 여섯 자 */
export const shortSettingsVersion = (version: string) => `v${version.slice(0, 6)}`;

let lastRead: { version: string; at: number } | null = null;

/** getSettings 가 읽을 때마다 남긴다 — 이 프로세스의 잡이 마지막으로 본 판 */
export function noteSettingsRead(version: string) {
  lastRead = { version, at: Date.now() };
}

/** 이 프로세스가 마지막으로 읽은 판과 그 시각(epoch ms). 아직 읽지 않았으면 null */
export function lastSettingsRead(): { version: string; at: number } | null {
  return lastRead;
}

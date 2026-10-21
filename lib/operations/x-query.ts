import { createHmac } from "node:crypto";
import { isXQueryRepository } from "@/lib/social/x-query";

/**
 * X 수집기(osaka-smoke)가 그날 검색할 저장소를 웹에 묻는다 — 서명한 POST 하나(2026-10-21, 우리 제품 저장소 검색).
 *
 * 받는 쪽은 app/api/ops/x-query/route.ts, 묻는 쪽은 lib/social/x-report.ts 의 requestXQuery 다. 비밀은 하루 보고(x-status)와 같고
 * 서명 머리만 달라 다른 주소의 서명을 여기 다시 쓸 수 없다. 비밀이 없으면 주소는 404 다.
 *
 * - 묻는 본문: {"v":1,"day":"YYYY-MM-DD"} — day 는 서명에 묶인 보낸 시각의 UTC 날짜와 같아야 한다.
 * - 답: {"v":1,"day":…,"repositories":["owner/repo",…]} — 공개 제품의 저장소(소문자)만, 검색어 512자 안에 드는 만큼(lib/social/x-query.ts).
 *
 * 이 주소에 답한 웹은 게시물 보고 v2·하루 보고 v2 도 받는다(같은 변경으로 들어왔다). 수집기는 답을 받은 날만 v2 로 보낸다.
 */
export const X_QUERY_KEY = "x-query";
export const X_QUERY_MAX_BODY_BYTES = 256;
/** 수집기가 읽는 답 본문 상한 */
export const X_QUERY_MAX_RESPONSE_BYTES = 16_384;
/** 512자에 드는 저장소는 많아야 20곳(가장 짧은 조각 24자) — 받는 쪽은 넉넉히 40곳까지 */
export const X_QUERY_MAX_REPOSITORIES = 40;
const SIGNING_PREFIX = "nomorevibe-x-query-v1";

export type XQueryRequest = { v: 1; day: string };
export type XQueryResponse = { v: 1; day: string; repositories: string[] };

/** HMAC-SHA256(비밀, "nomorevibe-x-query-v1\n<보낸 시각>\n" + 본문 바이트) */
export function xQueryDigest(secret: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${SIGNING_PREFIX}\n${timestamp}\n`).update(body).digest();
}

export function signXQuery(secret: string, timestamp: number, body: string | Uint8Array): string {
  return `v1=${xQueryDigest(secret, timestamp, body).toString("hex")}`;
}

/** 유닉스 초의 UTC 날짜 */
export const utcDay = (seconds: number) => new Date(seconds * 1_000).toISOString().slice(0, 10);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** 묻는 본문 — 칸이 더 있거나 빠지거나, 날짜가 보낸 시각의 UTC 날짜가 아니면 null */
export function parseXQueryRequest(value: unknown, sentAt: number): XQueryRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["v", "day"]) || value.v !== 1) return null;
  return typeof value.day === "string" && DAY.test(value.day) && value.day === utcDay(sentAt) ? { v: 1, day: value.day } : null;
}

/** 답 — 물은 날짜의 답이고, 저장소는 소문자 owner/repo 를 겹치지 않게 40곳까지. 어긋나면 null(수집기는 고정 검색어로 돈다) */
export function parseXQueryResponse(value: unknown, day: string): XQueryResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ["v", "day", "repositories"]) || value.v !== 1 || value.day !== day) return null;
  const { repositories } = value;
  if (!Array.isArray(repositories) || repositories.length > X_QUERY_MAX_REPOSITORIES || !repositories.every(isXQueryRepository)) return null;
  return new Set(repositories).size === repositories.length ? { v: 1, day, repositories: [...repositories] } : null;
}

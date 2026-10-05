import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, crawlTaglines } from "@/lib/db/schema";
import { humanDecisions24h, taglineProgress, waitingAge } from "@/lib/crawl/review-overview";
import { ensureSchema, resetTables } from "./setup";

/** 심사 큐 머리 숫자 — 사람 결정 24시간, 구간의 나이, 소개 없음 후보의 AI 소개 */
const now = new Date("2026-10-05T12:00:00.000Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  for (const table of [crawlReviewAttempts, crawlTaglines, crawlCandidates]) await db.delete(table);
});

const candidate = async (repo: string, over: Partial<typeof crawlCandidates.$inferInsert> = {}) => (await db.insert(crawlCandidates)
  .values({ repo, state: "needs_review", reason: "second_review_split", decidedBy: "auto", updatedAt: ago(1), ...over }).returning())[0];

it("사람 결정은 최근 24시간의 admin_override 만 세고 승인·거부를 나눈다", async () => {
  const row = await candidate("people/decide");
  let n = 0;
  const attempt = (kind: string, decision: string, startedAt: Date): typeof crawlReviewAttempts.$inferInsert => ({
    candidateId: row.id, kind, state: "succeeded", inputHash: "i", policyHash: "p", sourceRevisionHash: "s", snapshot: {} as never,
    source: {} as never, promptVersion: "t", rulesVersion: "t", attemptNumber: ++n, validUntil: ago(-1), startedAt,
    outcome: { decision, reason: "r", evidenceIds: ["product"] } as never,
  });
  await db.insert(crawlReviewAttempts).values([
    attempt("admin_override", "approve", ago(2)),
    attempt("admin_override", "reject", ago(23)),
    attempt("admin_override", "approve", ago(25)),   // 24시간 밖
    attempt("automatic", "approve", ago(1)),          // 사람 결정이 아님
    attempt("admin_override", "approve", ago(-1)),   // 기준 시각 뒤
  ]);
  expect(await humanDecisions24h(now)).toEqual({ approve: 1, reject: 1 });
});

it("구간의 나이는 판정 시각(없으면 갱신 시각)으로 재고, 고른 후보만 본다", async () => {
  const old = await candidate("age/old", { judgedAt: ago(24 * 10 + 1) });
  const fresh = await candidate("age/fresh", { judgedAt: ago(2) });
  const unjudged = await candidate("age/unjudged", { judgedAt: null, updatedAt: ago(30) });
  await candidate("age/other", { judgedAt: ago(24 * 40) });
  expect(await waitingAge([old.id, fresh.id, unjudged.id], now)).toEqual({ oldestDays: 10, new24h: 1 });
  expect(await waitingAge([], now)).toEqual({ oldestDays: null, new24h: 0 });
});

it("AI 소개는 지음·근거로는 모름·실패·시도 전으로 나뉜다", async () => {
  const rows = await Promise.all(["t/written", "t/unknown", "t/failed", "t/untried"].map((repo) => candidate(repo, { reason: "no_description" })));
  const tagline = (repo: string, text: string, errorCode: string | null): typeof crawlTaglines.$inferInsert => ({
    repo, tagline: text, source: "page", model: "[MLX] gpt-oss-120b", sourceHash: "h", documentAt: ago(3), attempts: 1, errorCode,
  });
  await db.insert(crawlTaglines).values([tagline("t/written", "할 일을 모아 보는 웹앱", null), tagline("t/unknown", "", null), tagline("t/failed", "", "timeout")]);
  expect(await taglineProgress(rows.map((row) => row.id))).toEqual({ written: 1, unknown: 1, failed: 1, untried: 1 });
  expect(await taglineProgress([])).toEqual({ written: 0, unknown: 0, failed: 0, untried: 0 });
});

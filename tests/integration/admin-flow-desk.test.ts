import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { crawlCandidates, crawlPublicationChanges, operationsAudit } from "@/lib/db/schema";
import { readOperatorDesk } from "@/app/(operator)/admin/flow/desk";
import { ensureSchema } from "./setup";

/**
 * 전체 흐름의 운영자 책상 — 작업 로그(덧붙이기만 하는 표)의 "최근 바뀐 설정"과 내 마지막 기록 이후의 "부재 중"을 사설 시험 DB 에서 한 바퀴 읽는다.
 * 작업 로그는 지울 수 없어 행마다 이 실행만의 이름을 쓴다. 다른 칸(경보·장부)은 이 DB 에서 비어 있거나 못 읽을 수 있다 — 그때 null 이어야 한다(0 이 아니다).
 */
const run = Date.now().toString(36);
const me = `it-desk-me-${run}`;
const other = `it-desk-other-${run}`;
const repos = [`it-desk/${run}-held`, `it-desk/${run}-old-held`];
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

beforeAll(async () => {
  ensureSchema();
  await db.insert(operationsAudit).values([
    { actor: me, action: "job-pause", target: `it-job-${run}`, detail: { reason: "시험" }, createdAt: hoursAgo(5) },
    { actor: other, action: "ai-task-models-save", target: "first-review", detail: { before: [], after: [] }, createdAt: hoursAgo(1) },
    // 설정 변경이 아닌 줄은 "최근 바뀐 설정"에 오르지 않는다
    { actor: other, action: "export", target: "export:products", detail: {}, createdAt: hoursAgo(1) },
  ]);
  await db.insert(crawlCandidates).values([
    { repo: repos[0], state: "needs_review", reason: "second_review_split", updatedAt: hoursAgo(2) },
    { repo: repos[1], state: "needs_review", reason: "second_review_split", updatedAt: hoursAgo(9) },
  ]);
  await db.insert(crawlPublicationChanges).values({ repo: `it-desk/${run}-pub`, delta: 1, occurredAt: hoursAgo(3) });
});
afterAll(async () => {
  await db.delete(crawlCandidates).where(inArray(crawlCandidates.repo, repos));
  await db.execute(sql`DELETE FROM crawl_publication_changes WHERE repo = ${`it-desk/${run}-pub`}`);
});

it("lists recent setting changes with where to undo them, and 'away' since my last logged action", async () => {
  const desk = await readOperatorDesk(me, true);
  expect(desk.changes).not.toBeNull();
  const ids = desk.changes!.map((change) => change.actor);
  expect(ids).toContain(other);
  expect(desk.changes!.some((change) => change.action === "export")).toBe(false);
  const rank = desk.changes!.find((change) => change.actor === other)!;
  expect(rank).toMatchObject({ label: "작업 ↔ 모델 순위 저장", undo: { href: "/admin/models#tasks" } });
  const pause = desk.changes!.find((change) => change.actor === me)!;
  expect(pause.undo.href).toBe(`/admin/status?tab=jobs&job=it-job-${run}`);

  expect(desk.away).not.toBeNull();
  expect(desk.away!.fromMyLastAction).toBe(true);
  expect(Math.abs(Date.parse(desk.away!.since) - hoursAgo(5).getTime())).toBeLessThan(60_000);
  // 5시간 안에 보류로 바뀐 것만(9시간 전 것은 빠진다), 다른 사람의 설정 변경만
  expect(desk.away!.newHolds).toBeGreaterThanOrEqual(1);
  expect(desk.away!.published).toBeGreaterThanOrEqual(1);
  expect(desk.away!.othersChanges.map((change) => change.actor)).toContain(other);
  expect(desk.away!.othersChanges.map((change) => change.actor)).not.toContain(me);

  // 「할 일 → 모두 보기」(예전 오늘 할 일 화면) — 열네 칸이 일이 있거나 못 읽은 칸(sections)과 빈 칸(clear)으로 빠짐없이 나뉜다
  if (desk.decisions) {
    expect(desk.decisions.sections.length + desk.decisions.clear.length).toBe(14);
    for (const section of desk.decisions.sections) expect(section.count === null || section.count > 0, section.key).toBe(true);
    expect(desk.decisions.items.every((item) => desk.decisions!.sections.some((section) => section.key === item.key))).toBe(true);
  }
});

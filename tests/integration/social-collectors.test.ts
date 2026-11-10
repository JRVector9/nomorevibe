import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, jobs, operationsObservations, products } from "@/lib/db/schema";
import { jobRuntimeState, readSocialCollectors, readSocialFlowOverview } from "@/lib/operations/flow-overview-read";
import { recordSocialPosts, type SocialPostInput } from "@/lib/social/repository";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 콘텐츠 운영 SNS 탭의 수집기 줄(readSocialCollectors)과 운영 홈 SNS 칸(readSocialFlowOverview)이 같은 DB 에서 같은 판정을 읽는다.
 * 수집기 줄은 제품 연결 수를 세지 않는 가벼운 집계다 — 두 SQL 갈래가 실제 Postgres 에서 돈다.
 */
const JOBS = ["hn-talk", "bluesky-talk"];
const KEYS = ["x-status", "job:hn-talk", "job:bluesky-talk"];
let originalJobs: (typeof jobs.$inferSelect)[] = [];
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];
let originalObservations: (typeof operationsObservations.$inferSelect)[] = [];

const post = (id: string, repositoryKey: string | null, extra: Partial<SocialPostInput> = {}): SocialPostInput => ({
  externalId: id, kind: "link", title: "", linkUrl: repositoryKey ? `https://github.com/${repositoryKey}` : "https://acme.github.io/site",
  linkTarget: repositoryKey ? "repo" : "site", repositoryKey, postedAt: new Date(Date.now() - 3_600_000), points: 3, comments: 0, frontPage: false, ...extra,
});

beforeAll(async () => {
  await ensureSchema();
  [originalJobs, originalSettings, originalObservations] = await Promise.all([
    db.select().from(jobs).where(inArray(jobs.name, JOBS)), db.select().from(crawlSettings),
    db.select().from(operationsObservations).where(inArray(operationsObservations.key, KEYS)),
  ]);
  await db.execute(sql`TRUNCATE social_post_observations, social_posts, social_talk_decisions RESTART IDENTITY CASCADE`);
  await resetTables();
  await db.delete(jobs).where(inArray(jobs.name, JOBS));
  await db.delete(operationsObservations).where(inArray(operationsObservations.key, KEYS));
  await db.insert(crawlSettings).values({ id: 1, values: { enabled: true }, updatedBy: "social-collectors-fixture" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: { enabled: true }, updatedBy: "social-collectors-fixture" } });
});

afterAll(async () => {
  await db.delete(jobs).where(inArray(jobs.name, JOBS));
  if (originalJobs.length) await db.insert(jobs).values(originalJobs);
  await db.delete(crawlSettings);
  if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
  await db.delete(operationsObservations).where(inArray(operationsObservations.key, KEYS));
  if (originalObservations.length) await db.insert(operationsObservations).values(originalObservations);
  await db.execute(sql`TRUNCATE social_post_observations, social_posts, social_talk_decisions RESTART IDENTITY CASCADE`);
});

it("수집기 줄과 운영 홈 SNS 칸이 같은 출처별 수·잡 판정을 읽고, 수집기 줄은 제품 연결 수를 세지 않는다", async () => {
  const now = new Date();
  await db.insert(products).values({ slug: "acme-app", name: "acme-app", url: "https://acme-app.example", tagline: "t", description: "d", category: "Dev",
    repoUrl: "https://github.com/acme/app", status: "seeded", source: "crawler", verifyToken: "v-acme-app", editTokenHash: "a".repeat(64) });
  await recordSocialPosts("hn", [post("1", "acme/app", { title: "Show HN: Acme" })], now);
  await recordSocialPosts("bluesky", [post("did:plc:abcdefghijklmnopqrstuvwx/3lbcdefghij2k", "acme/app"),
    post("did:plc:abcdefghijklmnopqrstuvwx/3lbcdefghij3k", "other/none"), post("did:plc:abcdefghijklmnopqrstuvwx/3lbcdefghij4k", null)], now);
  // HN 은 10분 전 성공(동작 중), Bluesky 는 13시간 전 성공 — 2시간 잡의 경보 기준(6주기 = 12시간)을 넘겨 수집 지연
  await db.insert(jobs).values([
    { name: "hn-talk", lastRunAt: new Date(now.getTime() - 10 * 60_000), lastSuccessAt: new Date(now.getTime() - 10 * 60_000) },
    { name: "bluesky-talk", lastRunAt: new Date(now.getTime() - 13 * 3_600_000), lastSuccessAt: new Date(now.getTime() - 13 * 3_600_000) },
  ]);

  const status = await readSocialCollectors();
  const by = Object.fromEntries(status.collectors.map(row => [row.source, row]));
  expect(by.hn).toMatchObject({ status: "동작 중", tone: "green", stored: 1, new24h: 1, statusHref: "/admin/status?tab=jobs&job=hn-talk" });
  expect(by.bluesky).toMatchObject({ status: "수집 지연", tone: "amber", stored: 3, new24h: 3 });
  expect(by.x).toMatchObject({ status: "보고 없음", stored: 0 });
  expect(by.geeknews).toMatchObject({ status: "수집 잡 없음", statusHref: null });
  expect(Date.parse(by.hn.lastSuccessAt!)).toBeCloseTo(now.getTime() - 10 * 60_000, -3);

  // 운영 홈은 작업 제어 판(listJobStates)의 행을 같은 jobRuntimeState 로 넘긴다
  const rows = await db.select().from(jobs).where(inArray(jobs.name, JOBS));
  const overview = await readSocialFlowOverview(Object.fromEntries(rows.map(row => [row.name, jobRuntimeState(row, Date.now())])));
  expect(overview.collectors.map(row => [row.source, row.status, row.stored])).toEqual(status.collectors.map(row => [row.source, row.status, row.stored]));
  expect(overview).toMatchObject({ stored: 4, new24h: 4, linked: 2 });
});

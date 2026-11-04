import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlTaglines, crawlSettings, jobs, textTranslations } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { pendingTaglines, writeTaglineByHand, recordTaglineResult } from "@/lib/crawl/taglines";
import { runJob, getJobState } from "@/lib/jobs/runner";
import { recordWorkerTranslations, recordTranslations } from "@/lib/crawl/translations";
import { textHash } from "@/lib/crawl/translate";
import { taglineEvidence, writeTagline } from "@/lib/crawl/tagline";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { ensureSchema } from "./setup";
import { pinTextRanks, textContract } from "../text-task-ranks-fixture";

/**
 * 게이트웨이(abcLLM)는 2026-10-30 제거됐다 — 소개 짓기 잡은 직접 연결 계약이 있어야 돌고, 용량을 끈 잡이 부르는 옛 잎 writeTagline 은
 * 보내지 않고 no_key 로 끝난다(crawl-tagline.test.ts 가 본다). 이 파일은 늦게 온 답의 쓰기 울타리를 보므로, 그 잎만 같은 wire 를 전역 fetch
 * 목으로 보내는 대역으로 바꾼다(direct-engine-fixtures).
 * 2026-11-02(PR B): 모델은 「작업 ↔ 모델」 순위가 고른다 — 순위를 고정하고(pinTextRanks) 그 연결의 엔진 직접 계약 행(textContract)을 넣는다.
 */
// 1순위 모델 — 예전 TAGLINE_MODEL(등록부 기본값)과 같은 이름이다
const { TAGLINE_MODEL } = vi.hoisted(() => ({ TAGLINE_MODEL: "qwen3.6-35b-heretic" }));
const capacityHook = vi.hoisted(() => ({ tagline: null as null | ((task: { candidate: { repo: string };
  document: Parameters<typeof import("@/lib/crawl/tagline").taglineEvidence>[1] },
  options: { timeoutMs: number; signal?: AbortSignal; previous?: unknown }) => Promise<unknown>) }));
vi.mock("@/lib/crawl/tagline-model-capacity", () => ({
  writeCrawlTaglineWithModelCapacity: (task: { candidate: { repo: string };
    document: Parameters<typeof import("@/lib/crawl/tagline").taglineEvidence>[1] },
  _job: unknown, options: { timeoutMs: number; signal?: AbortSignal; previous?: unknown }) => capacityHook.tagline!(task, options),
}));
vi.mock("@/lib/crawl/tagline", async load => {
  const original = await load<typeof import("@/lib/crawl/tagline")>();
  const { askRemovedGatewayLeaf, replyContent } = await import("./direct-engine-fixtures");
  const writeTagline: typeof original.writeTagline = (evidence, options) => askRemovedGatewayLeaf(original.writeTagline(evidence, options),
    options.request ?? fetch, original.crawlTaglineGatewayWire(evidence, options.model ?? TAGLINE_MODEL),
    async response => original.parseTagline(await replyContent(response), evidence), options);
  return { ...original, writeTagline };
});
capacityHook.tagline = async (task, options) => ({ kind: "result",
  result: await writeTagline(taglineEvidence(task.candidate.repo, task.document), { signal: options.signal, timeoutMs: options.timeoutMs }),
  askOrdinal: options.previous ? 2 as const : 1 as const, parent: null, expectation: undefined });

beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [crawlTaglines, crawlCandidates, crawlDocuments, crawlSettings, jobs, textTranslations]) await db.delete(table);
  await saveSettings({ enabled: true }, "fixture");
  pinTextRanks({ "crawl-tagline": TAGLINE_MODEL });
  setServingContractSnapshotForTest([textContract("crawl-tagline", TAGLINE_MODEL)]);
  await crawl.putDocument({ repo: "fence/app", productUrl: "https://fence.example", repoMeta: {}, pageStatus: 200,
    pageMeta: { title: "My App", textSample: "A task management application" } });
  await crawl.recordJudgement({ repo: "fence/app", productUrl: "https://fence.example", state: "needs_review", reason: "no_description", decidedBy: "auto" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); pinTextRanks(null); });
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tagline: "업무를 관리하는 앱", source: "page" }) } }] }));

it.each(["success", "failure"])("late AI %s preserves a manual insert made during the call", async kind => {
  const [task] = await pendingTaglines(1);
  vi.stubGlobal("fetch", vi.fn(async () => {
    await writeTaglineByHand({ repo: task.candidate.repo, tagline: "관리자가 작성한 문구", by: "admin", documentAt: task.document.fetchedAt });
    return kind === "success" ? answer() : new Response("", { status: 429 });
  }));
  expect(await runJob("crawl-tagline", writeTaglines)).toMatchObject({ status: "completed" });
  expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "관리자가 작성한 문구", writtenBy: "admin", attempts: 0, errorCode: null });
  expect(await crawl.getCandidate(task.candidate.repo)).toMatchObject({ state: "needs_review" });
  expect(await getJobState("crawl-publish")).toBeUndefined();
});
it("late result cannot release a candidate after its document changes", async () => {
  const stop = new AbortController();
  vi.stubGlobal("fetch", vi.fn(async () => {
    await db.update(crawlDocuments).set({ pageMeta: { title: "New source" } });
    // End this tick after the one in-flight response, so we inspect the stale write alone.
    stop.abort(); return answer();
  }));
  await runJob("crawl-tagline", writeTaglines, { signal: stop.signal });
  expect(await db.select().from(crawlTaglines)).toHaveLength(0);
  expect((await crawl.getCandidate("fence/app"))?.state).toBe("needs_review");
  expect(await getJobState("crawl-publish")).toBeUndefined();
});
it("a replacement lease blocks a late write", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    await db.update(jobs).set({ leaseToken: "replacement" }).where(eq(jobs.name, "crawl-tagline"));
    return answer();
  }));
  expect(await runJob("crawl-tagline", writeTaglines)).toMatchObject({ status: "failed" });
  expect(await db.select().from(crawlTaglines)).toHaveLength(0);
  expect((await crawl.getCandidate("fence/app"))?.state).toBe("needs_review");
});
it("measures tagline wait with the database clock", async () => {
  await db.update(crawlCandidates).set({ updatedAt: sql`localtimestamp - interval '5 minutes'` });
  const [task] = await pendingTaglines(1);
  expect(task.readyAgeMinutes).toBeGreaterThan(4);
  expect(task.readyAgeMinutes).toBeLessThan(6);
});
it("tagline, release and publication request roll back together", async () => {
  await db.insert(jobs).values({ name: "crawl-publish", requestedVersion: Number.MAX_SAFE_INTEGER });
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  expect(await runJob("crawl-tagline", writeTaglines)).toMatchObject({ status: "failed" });
  expect(await db.select().from(crawlTaglines)).toHaveLength(0);
  expect((await crawl.getCandidate("fence/app"))?.state).toBe("needs_review");
});
it("a current successful tagline wakes publication", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  await runJob("crawl-tagline", writeTaglines);
  expect((await getJobState("crawl-publish"))?.requestedVersion).toBe(1);
});

it.each(["success", "failure", "reuse"] as const)("source CAS blocks %s without relying on shutdown", async kind => {
  const [task] = await pendingTaglines(1);
  const lease = { name: "crawl-tagline", token: "old", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date() });
  await db.update(crawlDocuments).set({ pageMeta: { title: "replacement" } });
  const result = kind === "success" ? { kind, tagline: "늦은 문구", source: "page" as const, model: "fixture" }
    : kind === "failure" ? { kind, error: "timeout" } : { kind };
  expect(await recordTaglineResult(task, lease, result)).toEqual({ stored: false, released: false });
  expect(await db.select().from(crawlTaglines)).toHaveLength(0);
  expect(await getJobState("crawl-publish")).toBeUndefined();
});
it("worker translation writes roll back on a lost lease, while HTTP translations need no worker lease", async () => {
  const lease = { name: "reason-translate", token: "old", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: "new", lockedAt: new Date() });
  const rows = [{ hash: textHash("fixture"), translated: "테스트" }];
  await expect(recordWorkerTranslations(rows, "fixture", lease)).rejects.toThrow("job_lease_lost");
  expect(await db.select().from(textTranslations)).toHaveLength(0);
  await recordTranslations(rows, "fixture", "en");
  expect(await db.select().from(textTranslations)).toMatchObject([{ targetLang: "en", status: "done" }]);
});

it("a manual insert wins even after the automatic transaction selected an absent row", async () => {
  const [task] = await pendingTaglines(1);
  const lease = { name: "crawl-tagline", token: "owner", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date() });
  await db.execute(sql`CREATE FUNCTION nmv_test_pause_tagline() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.written_by IS NULL THEN PERFORM pg_advisory_xact_lock(741120); END IF; RETURN NEW; END $$`);
  await db.execute(sql`CREATE TRIGGER nmv_test_pause_tagline BEFORE INSERT ON crawl_taglines FOR EACH ROW EXECUTE FUNCTION nmv_test_pause_tagline()`);
  let automatic: ReturnType<typeof recordTaglineResult> | undefined;
  try {
    await db.transaction(async blocker => {
      await blocker.execute(sql`select pg_advisory_xact_lock(741120)`);
      automatic = recordTaglineResult(task, lease, { kind: "success", tagline: "늦은 자동 문구", source: "page", model: "fixture" });
      automatic.catch(() => {});
      let waiting = false;
      for (let i = 0; i < 40; i++) {
        const rows = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and objid = 741120 and not granted`);
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writeTaglineByHand({ repo: task.candidate.repo, tagline: "사람이 먼저 저장", by: "admin", documentAt: task.document.fetchedAt });
    });
    expect(await automatic).toEqual({ stored: false, released: false });
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "사람이 먼저 저장", writtenBy: "admin", attempts: 0 });
    expect(await getJobState("crawl-publish")).toBeUndefined();
  } finally {
    await automatic?.catch(() => {});
    await db.execute(sql`DROP TRIGGER IF EXISTS nmv_test_pause_tagline ON crawl_taglines`);
    await db.execute(sql`DROP FUNCTION IF EXISTS nmv_test_pause_tagline()`);
  }
});

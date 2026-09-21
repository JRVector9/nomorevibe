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
import { ensureSchema } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [crawlTaglines, crawlCandidates, crawlDocuments, crawlSettings, jobs, textTranslations]) await db.delete(table);
  await saveSettings({ enabled: true }, "fixture");
  vi.stubEnv("ABCLLM_API_KEY", "test-key");
  await crawl.putDocument({ repo: "fence/app", productUrl: "https://fence.example", repoMeta: {}, pageStatus: 200,
    pageMeta: { title: "My App", textSample: "A task management application" } });
  await crawl.recordJudgement({ repo: "fence/app", productUrl: "https://fence.example", state: "needs_review", reason: "no_description", decidedBy: "auto" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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

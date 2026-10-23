import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assistInputHash, ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash, ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { actionAuditClaimEligible } from "@/lib/domain/llm-assist/audit-runtime";
import { collectNewsLocalizationRuntimeInput, completeNewsLocalizationRuntime, enqueueNewsLocalizationRuntimeDemand,
  lockNewsLocalizationRuntimeInput, newsLocalizationClaimEligible, newsLocalizationRuntimeInputMatches,
  newsLocalizationRuntimeSourceHash } from "@/lib/domain/llm-assist/news-runtime";
import { lockNewsLocalizationSource } from "@/lib/news/localization-repository";
import { buildNewsLocalizationInput, NEWS_LOCALIZATION_POLICY_VERSION, type NewsLocalizationSource } from "@/lib/news/localization-contract";
import type { NewsLocalizationCandidate } from "@/lib/news/localization-work";
import { ensureSchema } from "./setup";

const prefix = `audit-news-runtime-${randomUUID().slice(0, 8)}`, enabled = { env: { NEWS_LOCALIZATION_BACKEND_ENABLED: "true" } };
let newsId = 0, source: NewsLocalizationSource;
let originalControl: Record<string, unknown> | null = null;
beforeAll(async () => {
  ensureSchema();
  const [row] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) row from llm_assist_controls c where task='news'`);
  originalControl = row?.row ?? null;
});
beforeEach(async () => {
  if (newsId) await db.execute(sql`delete from news_items where id=${newsId} and source_key=${prefix}`);
  await db.execute(sql`insert into llm_assist_controls(task,mode,dispatch_enabled,apply_enabled,revision)
    values ('news','shadow',true,false,7) on conflict(task) do update set mode='shadow',dispatch_enabled=true,apply_enabled=false,revision=7`);
  const [row] = await db.execute<{ id: number }>(sql`insert into news_items(source_key,url,title,summary,published_at,state,decided_by,decided_at,created_at)
    values (${prefix},${`https://example.test/${prefix}/${randomUUID()}`},'Acme releases Atlas in public beta.',
      'General availability has not been announced.',clock_timestamp(),'pending','auto','2026-10-23 01:02:03.123456'::timestamp,
      '2026-10-23 01:02:00.123456'::timestamp) returning id`);
  newsId = row.id;
  source = (await db.transaction(tx => lockNewsLocalizationSource(tx, newsId)))!;
});
afterAll(async () => {
  if (newsId) await db.execute(sql`delete from news_items where id=${newsId} and source_key=${prefix}`);
  if (originalControl) await db.execute(sql`update llm_assist_controls c set mode=r.mode,dispatch_enabled=r.dispatch_enabled,
    apply_enabled=r.apply_enabled,revision=r.revision,updated_at=r.updated_at
    from jsonb_populate_record(null::llm_assist_controls,${JSON.stringify(originalControl)}::jsonb) r where c.task='news'`);
  else await db.execute(sql`delete from llm_assist_controls where task='news'`);
});
const candidate = (): NewsLocalizationCandidate => ({ kind: "news", locale: "ko", news: source });
async function count(table: "llm_assist_work" | "news_localizations") {
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where news_item_id=${newsId}`);
  return row.n;
}

describe("뉴스 실제 원문·공통 큐 runtime adapter", () => {
  it("기본off와task off가명시수요를닫고원문상태를유지한다", async () => {
    expect(await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, { env: {} }))).toEqual({ state: "disabled" });
    await db.execute(sql`update llm_assist_controls set mode='off',dispatch_enabled=false where task='news'`);
    expect(await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled))).toEqual({ state: "disabled" });
    expect(await count("llm_assist_work")).toBe(0);
    expect((await db.transaction(tx => lockNewsLocalizationSource(tx, newsId)))?.state).toBe("pending");
  });
  it("동시명시수요를원문·locale로합치고raw microseconds와pending상태를보존한다", async () => {
    const results = await Promise.all([0, 1].map(() => db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled))));
    expect(results.filter(result => result.state === "queued" && result.created)).toHaveLength(1);
    expect(results.filter(result => result.state === "queued" && !result.created)).toHaveLength(1);
    const [work] = await db.execute<{ source: NewsLocalizationCandidate; source_hash: string; product_id: number | null; origin_job: string }>(
      sql`select source,source_hash,product_id,origin_job from llm_assist_work where news_item_id=${newsId}`);
    expect(work.source.news.revision).toBe("2026-10-23 01:02:03.123456");
    expect(work.source.news.state).toBe("pending"); expect(work.product_id).toBeNull();
    expect(work.origin_job).toBe("news-refresh"); expect(work.source_hash).toBe(newsLocalizationRuntimeSourceHash(candidate()));
  });
  it("새원문revision은새수요가되며과거입력·claim은현재자료로통과하지않는다", async () => {
    await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled));
    const input = buildNewsLocalizationInput(source);
    expect(newsLocalizationRuntimeInputMatches(candidate(), input)).toBe(true);
    expect(await db.transaction(tx => lockNewsLocalizationRuntimeInput(tx, candidate(), input, enabled))).toBe(true);
    expect((await collectNewsLocalizationRuntimeInput(candidate(), enabled)).kind).toBe("ready");
    await db.execute(sql`update news_items set decided_at=decided_at+interval '1 microsecond' where id=${newsId}`);
    expect(await db.transaction(tx => lockNewsLocalizationRuntimeInput(tx, candidate(), input, enabled))).toBe(false);
    expect(await collectNewsLocalizationRuntimeInput(candidate(), enabled)).toMatchObject({ kind: "obsolete" });
    await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled));
    expect(await count("llm_assist_work")).toBe(2);
    const rows = await db.execute<{ eligible: boolean }>(sql`select ${newsLocalizationClaimEligible()} eligible
      from llm_assist_work w join news_items on news_items.id=w.news_item_id where w.news_item_id=${newsId} order by w.created_at`);
    expect(rows.map(row => row.eligible)).toEqual([false, true]);
  });
  it("hidden·dispatch중단은기존pending후보를다시활성화하지않는다", async () => {
    const input = buildNewsLocalizationInput(source);
    await db.execute(sql`update llm_assist_controls set dispatch_enabled=false where task='news'`);
    expect(await db.transaction(tx => lockNewsLocalizationRuntimeInput(tx, candidate(), input, enabled))).toBe(false);
    await db.execute(sql`update llm_assist_controls set dispatch_enabled=true where task='news'`);
    await db.execute(sql`update news_items set state='hidden' where id=${newsId}`);
    expect(await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled))).toEqual({ state: "hidden" });
    expect(await db.transaction(tx => lockNewsLocalizationRuntimeInput(tx, candidate(), input, enabled))).toBe(false);
    expect(await count("news_localizations")).toBe(0);
  });
  it("실제result·settled native가없는JSON완료는초안쓰기권한을얻지못한다", async () => {
    const queued = await db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, newsId, enabled));
    if (queued.state !== "queued") throw new Error("queue_required");
    const input = buildNewsLocalizationInput(source);
    const value = { workId: queued.workId, resultId: randomUUID(), source: candidate(), sourceHash: newsLocalizationRuntimeSourceHash(candidate()),
      inputHash: assistInputHash(input), policyVersion: NEWS_LOCALIZATION_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
      backendId: "fixture-qwen", modelFamily: "qwen3.8-flash-next", modelId: "fixture-model", contractHash: "a".repeat(64),
      promptHash: assistPromptHash("news"), responseHash: "b".repeat(64), outcome: { schema_version: ASSIST_SCHEMA_VERSION } };
    expect(await db.transaction(tx => completeNewsLocalizationRuntime(tx, value, enabled))).toEqual({ state: "unverified_result" });
    expect(await db.transaction(tx => completeNewsLocalizationRuntime(tx, value, { env: {} }))).toEqual({ state: "disabled" });
    expect(await count("news_localizations")).toBe(0);
    expect((await db.transaction(tx => lockNewsLocalizationSource(tx, newsId)))?.title).toBe(source.title);
  });
});

it("감사claim SQL도Qwen장비변경을독립으로세지않고정확한preferred family만고른다", async () => {
  for (const [original, auditor, expected] of [["qwen3.8-flash-next", "deepseek-v4.1-flash-1017", true],
    ["qwen3.8-flash-next", "qwen3.8-flash-next", false], ["deepseek-v4.1-flash-1017", "qwen3.8-flash-next", true],
    ["gpt-oss-120b", "qwen3.8-flash-next", true], ["unknown", "qwen3.8-flash-next", false],
    [null, "deepseek-v4.1-flash-1017", false], ["qwen3.8-flash-next", "m1-qwen", false]] as const) {
    const [row] = await db.execute<{ eligible: boolean }>(sql`select ${actionAuditClaimEligible(auditor)} eligible
      from (select 'decision_audit'::text task,${JSON.stringify({ decision: { modelFamily: original } })}::jsonb source) w`);
    expect(row.eligible).toBe(expected);
  }
});

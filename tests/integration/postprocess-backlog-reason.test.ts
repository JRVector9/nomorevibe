import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { crawlCandidates, operationsObservations, secondReviews, textTranslations } from "@/lib/db/schema";
import { textHash } from "@/lib/crawl/translate";
import { retryableTranslations, untriedTranslations } from "@/lib/crawl/translations";
import { reasonTranslationInputHash, reasonTranslationLogicalWorkKey, type ReasonTranslationMember } from "@/lib/llm/capacity";
import { requestReasonTranslationModelSlot } from "@/lib/llm/capacity-repository";
import { readWorkerProgress } from "@/lib/operations/worker-progress-query";
import { clearAllMemos } from "@/lib/cache/memo";
import { admin, cleanupCapacityFixture, fixtureOwner, policy, setCapacityMode } from "./postprocess-backlog-fixture";
import { ensureSchema, resetTables } from "./setup";

const MODEL = "postprocess-backlog-reason-model";
const bodies = ["Newest English reason held by an unknown dispatch", "Second English reason that is free to translate",
  "Third English reason that is free to translate"];
async function reasons() {
  for (const [index, body] of bodies.entries()) {
    const [candidate] = await db.insert(crawlCandidates).values({ repo: `fixture/pb-reason-${index}`, state: "approved" }).returning();
    await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo, trigger: "sample", firstDecision: "approve",
      inputHash: "a".repeat(64), provider: "abcllm", model: "fixture", secondReason: body,
      reviewedAt: new Date(Date.now() - (index + 1) * 30 * 60_000) });
  }
  return bodies.map(textHash);
}
async function holdForeign(owner: { instanceId: string; bootId: string }, hashes: string[]) {
  const members: ReasonTranslationMember[] = hashes.map(sourceHash => ({ sourceHash, cache: { kind: "absent" } }));
  const workKey = `${reasonTranslationLogicalWorkKey(members)}:${reasonTranslationInputHash({ members, model: MODEL })}`;
  const slot = await requestReasonTranslationModelSlot({ requestId: randomUUID(), owner, workKey, class: "background", pool: "text",
    routeId: "reason-translate", provider: "abcllm", model: MODEL }, members);
  expect(["granted", "deferred"]).toContain(slot.kind);
}
const stage = async () => (await readWorkerProgress()).stages.find(row => row.stage === "reason-translate")!;

beforeAll(ensureSchema);
async function clearReasons() {
  await db.delete(secondReviews); await db.delete(textTranslations); await db.delete(crawlCandidates); await db.delete(operationsObservations);
}
beforeEach(async () => {
  await resetTables(); clearAllMemos(); await clearReasons();
  await db.insert(operationsObservations).values(["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"]
    .map(role => ({ key: `service:${role}:fixture`, value: { status: "running" }, observedAt: new Date() })));
});
afterEach(cleanupCapacityFixture);
// 뒤 파일(reason-translation-capacity-dispatch 등)은 빈 사유 대기열에서 시작한다
afterAll(async () => { await clearReasons(); await admin.end({ timeout: 5 }); });

it("skips the newest reason held by another request instead of re-picking the same fenced head every tick", async () => {
  const [held, second, third] = await reasons();
  await setCapacityMode("open", policy([{ routeId: "reason-translate", model: MODEL }]));
  const other = fixtureOwner("reason-other"), self = fixtureOwner("reason-self");
  await holdForeign(other, [held]);
  expect((await untriedTranslations(8, self)).map(row => row.hash)).toEqual([second, third]);
  expect((await untriedTranslations(8, undefined)).map(row => row.hash)).toEqual([second, third]);
  // 같은 boot 의 대기·예약은 조정기가 이어받는다
  expect((await untriedTranslations(8, other)).map(row => row.hash)).toEqual([held, second, third]);
  await setCapacityMode("disabled");
  expect((await untriedTranslations(8, self)).map(row => row.hash)).toEqual([held, second, third]);
});

it("skips a held due retry too, so the retry lane cannot pin the tick either", async () => {
  const [, second, third] = await reasons();
  for (const hash of [second, third]) await db.insert(textTranslations).values({ sourceHash: hash, targetLang: "ko", status: "failed",
    attempts: 1, errorCode: "timeout", retryAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 20 * 60_000) });
  await setCapacityMode("open", policy([{ routeId: "reason-translate", model: MODEL }]));
  await holdForeign(fixtureOwner("reason-retry-other"), [second]);
  expect((await retryableTranslations(8, fixtureOwner("reason-retry-self"))).map(row => row.hash)).toEqual([third]);
});

it("reports no_progress while nothing is written and clears it as soon as a translation lands, with the same alarm rules", async () => {
  const [held, second] = await reasons();
  expect(await stage()).toMatchObject({ reason: "no_progress", alarm: true, waiting: 3, completed5m: 0 });
  await db.insert(textTranslations).values({ sourceHash: second, targetLang: "ko", status: "done", translated: "번역된 사유",
    model: MODEL, attempts: 1, updatedAt: new Date() });
  expect(await stage()).toMatchObject({ reason: "progressing", alarm: false, waiting: 2, completed5m: 1 });
  expect(held).toBe(textHash(bodies[0]));
});

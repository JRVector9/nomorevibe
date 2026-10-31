import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { directContractRow } from "./direct-engine-fixtures";

/**
 * 게이트웨이(abcLLM)는 2026-10-30 제거됐다. 잡은 이 경로·모델의 직접 연결 계약이 있어야 돌고, 용량을 끈(disabled) 잡이 부르는 옛 잎
 * verifyKeywords·verifyKeywordsInChunks 는 이제 보내지 않고 no_key 로 끝난다. 이 파일은 잡이 답을 받은 뒤의 판단(차례·실패 시각·색인 사본)을
 * 보므로, 한 번에 묻는 잎만 같은 wire(searchVerifyGatewayWire)를 이 파일의 fetch 목으로 보내는 대역으로 바꾼다(direct-engine-fixtures).
 * 묶음 잎은 진짜 그대로 두고 부른 것만 센다 — 묶음 단계의 전송·완결 기록은 native 경로가 맡는다(search-verify-capacity-dispatch).
 */
const leaves = vi.hoisted(() => ({ chunks: [] as string[][] }));
vi.mock("@/lib/domain/products/search-verify", async load => {
  const original = await load<typeof import("@/lib/domain/products/search-verify")>();
  const { askRemovedGatewayLeaf, replyContent } = await import("./direct-engine-fixtures");
  const verifyKeywords: typeof original.verifyKeywords = (item, options) => askRemovedGatewayLeaf(original.verifyKeywords(item, options),
    options.request ?? fetch, original.searchVerifyGatewayWire(item, options.model ?? original.VERIFY_MODEL), async response => {
      const content = await replyContent(response);
      try { return { ok: true as const, unsupported: original.parseVerification(item.keywords, content) }; }
      catch { return { ok: false as const, error: "invalid_output" }; }
    }, options);
  const verifyKeywordsInChunks: typeof original.verifyKeywordsInChunks = (item, options) => {
    leaves.chunks.push([...item.keywords]);
    return original.verifyKeywordsInChunks(item, options);
  };
  return { ...original, verifyKeywords, verifyKeywordsInChunks };
});
// 키워드를 다시 짓는 잡(writeSearchProfiles)의 옛 잎도 같은 대역이다(search-profile.test.ts 와 같다)
vi.mock("@/lib/domain/products/search-profile", async load => {
  const original = await load<typeof import("@/lib/domain/products/search-profile")>();
  const { askRemovedGatewayLeaf } = await import("./direct-engine-fixtures");
  const writeKeywords: typeof original.writeKeywords = (evidence, options) => askRemovedGatewayLeaf(original.writeKeywords(evidence, options),
    options.request ?? fetch, original.profileGatewayWire(evidence, options.model ?? original.PROFILE_MODEL),
    async response => original.parseProfileGatewayBody(await response.text(), evidence.name), options);
  return { ...original, writeKeywords };
});

const { db } = await import("@/lib/db");
const { jobs, products, productSearchProfiles } = await import("@/lib/db/schema");
const { verifySearchKeywords } = await import("@/lib/jobs/products/search-verify");
const { writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");
const { PROFILE_MODEL, profileEvidence, profileHash } = await import("@/lib/domain/products/search-profile");
const { VERIFY_MODEL } = await import("@/lib/domain/products/search-verify");
const { runJob } = await import("@/lib/jobs/runner");
const { pendingVerifications, reconcileSearchProfileBatch } = await import("@/lib/domain/products/search-profiles");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, en: string[], ko: string[], values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug, category: "Sports",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", searchKeywords: [...en, ...ko].join(" · "), ...values,
  }).returning();
  await db.insert(productSearchProfiles).values({ productId: row.id, keywordsEn: en, keywordsKo: ko, sourceHash: profileHash(profileEvidence(row, null)), model: "m", attempts: 1 });
  return row.id;
}

type Answer = { status?: number; unsupported?: string[]; invalid?: boolean };
/** 가짜 게이트웨이 — 받은 제품의 키워드마다 fits 를 돌려준다 */
function gateway(pick: (name: string, keywords: string[]) => Answer): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const request = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    const user = body.messages[1].content as string;
    const input = JSON.parse(user.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { evidence: { name: string }; keywords: string[] };
    calls.push(input.evidence.name);
    const answer = pick(input.evidence.name, input.keywords);
    const status = answer.status ?? 200;
    const checks = answer.invalid ? [] : input.keywords.map((keyword) => ({ keyword, searcher_wants: keyword, fits: !(answer.unsupported ?? []).includes(keyword) }));
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content: JSON.stringify({ product: "p", checks }) } }] }) };
  });
  return Object.assign(request as unknown as typeof fetch, { calls });
}

const tick = (request: typeof fetch) => runJob<null>("product-search-verify", (ctx) => verifySearchKeywords(ctx, request));
const profile = async (id: number) => (await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0];
const keywordsOf = async (id: number) => (await db.select({ k: products.searchKeywords }).from(products).where(eq(products.id, id)))[0].k;

beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(productSearchProfiles); await db.delete(jobs); leaves.chunks.length = 0;
  setServingContractSnapshotForTest([directContractRow("product-search-verify", VERIFY_MODEL)]); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });

describe("검색 키워드 검수 잡", () => {
  it("검수를 오래 기다린 제품을 새 제품보다 먼저 집는다", async () => {
    const older = await seed("older-waiting", ["older keyword"], []);
    const newer = await seed("newer-waiting", ["newer keyword"], []);
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '1 day'` })
      .where(eq(productSearchProfiles.productId, older));
    await db.update(productSearchProfiles).set({ updatedAt: sql`now()` })
      .where(eq(productSearchProfiles.productId, newer));

    expect((await pendingVerifications(1))[0]?.product.id).toBe(older);
  });

  it("preserves the failure cause so explicitly requeued exhausted checks take the chunk leaf, which no longer sends", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const id = await seed("reconciled-chunks", keys, []);
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 5 })
      .where(eq(productSearchProfiles.productId, id));
    await reconcileSearchProfileBatch({ apply: true, retryInvalidOutput: true });
    expect(await profile(id)).toMatchObject({ verifyError: "invalid_output", verifyAttempts: 0 });
    const request = gateway(() => ({}));
    await tick(request);
    // 묶음 잎을 골랐다. 그 잎의 게이트웨이 전송은 없어져 아무것도 보내지 않고, 공급자 쪽 실패(no_key)로 시도를 세지 않고 30분 쉰다
    expect(leaves.chunks).toEqual([keys]);
    expect(request.calls).toHaveLength(0);
    expect(await profile(id)).toMatchObject({ verifyError: "no_key", verifyAttempts: 0, verifiedAt: null, removedKeywords: [] });
  });
  it("respects retry backoff before the chunk leaf and commits nothing when it does not send", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const id = await seed("chunk-retry", keys, []);
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 1,
      verifyRetryAt: sql`now() + interval '1 hour'` }).where(eq(productSearchProfiles.productId, id));
    const request = gateway(() => ({ unsupported: [keys[7], keys[11]] }));
    await tick(request);
    expect(leaves.chunks).toHaveLength(0);
    expect(request.calls).toHaveLength(0);
    await db.update(productSearchProfiles).set({ verifyRetryAt: null }).where(eq(productSearchProfiles.productId, id));
    await tick(request);
    expect(leaves.chunks).toEqual([keys]);
    expect(request.calls).toHaveLength(0);
    expect(await profile(id)).toMatchObject({ verifyAttempts: 1, verifyError: "no_key", verifiedAt: null, removedKeywords: [] });
    expect(await keywordsOf(id)).toBe(keys.join(" · "));
  });
  // 앞 묶음의 뺄 키워드를 뒤 묶음 실패 때 버리는 규칙은 묶음 전송과 함께 native 경로로 옮겨 갔다:
  // search-verify-capacity-dispatch "dispatches each chunk and singleton under its own permit and writes only the complete verification".
  it("뒷받침되지 않는 키워드를 색인용 사본에서 빼고, 원본은 두고, 어느 모델이 봤는지 남긴다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["스포츠 학원 관리", "보너스 관리"]);
    const request = gateway(() => ({ unsupported: ["membership bonuses", "보너스 관리"] }));

    expect(await tick(request)).toMatchObject({ status: "completed", done: true });

    const row = await profile(id);
    expect(row.verifiedAt).not.toBeNull();
    expect(row).toMatchObject({ removedKeywords: ["membership bonuses", "보너스 관리"], verifyModel: "[supa] Qwen3.8-27B-NVFP4",
      keywordsEn: ["sports academy management", "membership bonuses"] });
    expect(await keywordsOf(id)).toBe("sports academy management · 스포츠 학원 관리");

    // 검수한 것은 다시 부르지 않는다
    await tick(request);
    expect(request.calls).toHaveLength(1);
  });

  it("모델이 내려가 있으면 틱을 접고 30분 쉰다 — 제품의 실패로 세지 않는다", async () => {
    const ids = [await seed("a", ["a app"], []), await seed("b", ["b app"], []), await seed("c", ["c app"], [])];
    const request = gateway(() => ({ status: 404 }));

    expect(await tick(request)).toMatchObject({ status: "completed", done: true });

    const rows = await Promise.all(ids.map(profile));
    const failed = rows.filter((row) => row.verifyError === "model_unavailable");
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row).toMatchObject({ verifyAttempts: 0, verifiedAt: null });
      const [{ minutes }] = await db.execute(sql`select extract(epoch from ${row.verifyRetryAt!.toISOString()}::timestamp - now()) / 60 as minutes`) as unknown as { minutes: number }[];
      expect(Number(minutes)).toBeGreaterThan(20);
    }
  });

  it("알아볼 수 없는 답은 실패로 센다", async () => {
    const id = await seed("garbled", ["coffee shop"], ["카페"]);
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "no json here" } }] }) });
    await tick(request as unknown as typeof fetch);
    expect(await profile(id)).toMatchObject({ verifiedAt: null, verifyError: "invalid_output", verifyAttempts: 1 });
  });

  it("일부만 판정하거나 빈 checks를 받으면 키워드를 지우지 않고 재시도한다", async () => {
    for (const checks of [[], [{ keyword: "coffee shop", fits: false }]]) {
      const id = await seed(`partial-${checks.length}`, ["coffee shop"], ["카페"]);
      const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ checks }) } }] }) });
      await tick(request as unknown as typeof fetch);
      expect(await profile(id)).toMatchObject({ verifiedAt: null, verifyError: "invalid_output", verifyAttempts: 1, removedKeywords: [] });
      expect(await keywordsOf(id)).toBe("coffee shop · 카페");
    }
  });

  it("키워드를 다시 지으면 검수를 비워 다시 본다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["보너스 관리"], { tagline: "Bonos de clases" });
    await tick(gateway(() => ({ unsupported: ["membership bonuses"] })));
    expect((await profile(id)).verifiedAt).not.toBeNull();

    // 글이 바뀌고 30일이 지나 키워드를 다시 짓는다
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    await db.update(products).set({ tagline: "Class packs for a football academy" }).where(eq(products.id, id));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content:
      JSON.stringify({ keywords_en: ["class pass management"], keywords_ko: ["수강권 관리"] }) } }] })));
    setServingContractSnapshotForTest([directContractRow("product-search-verify", VERIFY_MODEL), directContractRow("product-search-profile", PROFILE_MODEL)]);
    await runJob("product-search-profile", writeSearchProfiles);

    expect(await profile(id)).toMatchObject({ verifiedAt: null, removedKeywords: [], keywordsEn: ["class pass management"] });
    expect(await keywordsOf(id)).toBe("class pass management · 수강권 관리");
  });

  it("한 번에 넷을 부른다 — 같은 제품을 두 번 부르지 않는다", async () => {
    for (let i = 0; i < 16; i++) await seed(`p${i}`, [`keyword ${i}`], []);
    let inFlight = 0, peak = 0;
    const inner = gateway(() => ({}));
    const slow = (async (url: unknown, init?: unknown) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await (inner as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init); } finally { inFlight--; }
    }) as unknown as typeof fetch;
    await tick(slow);
    expect(peak).toBe(4);
    expect(inner.calls).toHaveLength(16);
    expect(new Set(inner.calls).size).toBe(16);
  });

  it("검수 도중 원본이 바뀌면 이전 응답을 저장하거나 키워드를 삭제하지 않는다", async () => {
    const id = await seed("changed-during-check", ["coffee shop"], ["카페"]);
    const inner = gateway(() => ({ unsupported: ["coffee shop"] }));
    const request = (async (...args: Parameters<typeof fetch>) => {
      await db.update(products).set({ tagline: "Workout diary" }).where(eq(products.id, id));
      return inner(...args);
    }) as typeof fetch;
    await tick(request);
    expect(await profile(id)).toMatchObject({ verifiedAt: null, removedKeywords: [], needsRefresh: true });
    expect(await keywordsOf(id)).toBe("coffee shop · 카페");
  });

  it("이전 데이터의 해시 불일치를 검수에서 만나면 재생성으로 넘겨 반복 호출하지 않는다", async () => {
    const id = await seed("old-hash", ["coffee shop"], []);
    await db.update(productSearchProfiles).set({ sourceHash: "old" }).where(eq(productSearchProfiles.productId, id));
    const request = gateway(() => ({}));
    await tick(request);
    expect(request.calls).toHaveLength(1);
    expect(await profile(id)).toMatchObject({ needsRefresh: true, verifiedAt: null });
  });

  it("공개되지 않은 제품·키워드가 없는 것은 부르지 않는다", async () => {
    await seed("hidden", ["x keyword"], [], { status: "banned" });
    await seed("empty", [], []);
    const request = gateway(() => ({}));
    await tick(request);
    expect(request.calls).toHaveLength(0);
  });

  it("직접 연결 계약이 없으면 부르지 않고 no_direct_contract 로 넘긴다 — 성공이 아니다", async () => {
    const id = await seed("no-contract", ["coffee shop"], []);
    setServingContractSnapshotForTest([]);
    const request = gateway(() => ({}));
    expect(await tick(request)).toMatchObject({ status: "completed", done: true, degraded: "no_direct_contract" });
    expect(request.calls).toHaveLength(0);
    expect(await profile(id)).toMatchObject({ verifiedAt: null, verifyError: null, verifyAttempts: 0 });
  });

  it("옛 잎(verifyKeywords)은 계약이 있어도 게이트웨이로 보내지 않고 no_key 로 끝난다", async () => {
    const request = gateway(() => ({}));
    const real = await vi.importActual<typeof import("@/lib/domain/products/search-verify")>("@/lib/domain/products/search-verify");
    const item = { evidence: profileEvidence({ name: "Cafe", url: "https://cafe.test", category: "Food", tagline: "Coffee", description: "Coffee",
      searchTopics: null, searchPageText: null, searchReadme: null }, null), keywords: ["coffee shop"] };
    expect(await real.verifyKeywords(item, { timeoutMs: 1_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(request.calls).toHaveLength(0);
  });
});

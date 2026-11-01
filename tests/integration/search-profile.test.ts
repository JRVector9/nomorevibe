import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { directContractRow } from "./direct-engine-fixtures";

/**
 * 게이트웨이(abcLLM)는 2026-10-30 제거됐다. 잡은 이 경로·모델의 직접 연결 계약이 있어야 돌고, 용량을 끈(disabled) 잡이 부르는 옛 잎
 * writeKeywords 는 이제 보내지 않고 no_key 로 끝난다(파일 끝 두 시험). 이 파일은 잡이 답을 받은 뒤의 판단(차례·실패 시각·생성 해시·색인 사본)을
 * 보므로, 그 잎만 같은 wire(profileGatewayWire)를 이 파일의 fetch 목(gateway)으로 보내는 대역으로 바꾼다(direct-engine-fixtures).
 * 검색어 번역(resolveSearchQuery)은 그 경로의 직접 연결 계약이 없어 부르지 않는다 — 번역 없이 색인만으로 찾는지 본다.
 */
vi.mock("@/lib/domain/products/search-profile", async load => {
  const original = await load<typeof import("@/lib/domain/products/search-profile")>();
  const { askRemovedGatewayLeaf } = await import("./direct-engine-fixtures");
  const writeKeywords: typeof original.writeKeywords = (evidence, options) => askRemovedGatewayLeaf(original.writeKeywords(evidence, options),
    options.request ?? fetch, original.profileGatewayWire(evidence, options.model ?? original.PROFILE_MODEL),
    async response => original.parseProfileGatewayBody(await response.text(), evidence.name), options);
  return { ...original, writeKeywords };
});

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, jobs, products, productSearchProfiles, textTranslations } = await import("@/lib/db/schema");
const { writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");
const { refreshProductSearchDocuments } = await import("@/lib/jobs/products/search-refresh");
const { productAuditCampaigns, productAuditItems } = await import("@/lib/db/product-audit-schema");
const { PROFILE_MODEL, profileEvidence, profileHash } = await import("@/lib/domain/products/search-profile");
const { pendingProfiles, pendingVerifications, reconcileSearchProfileBatch } = await import("@/lib/domain/products/search-profiles");
const { runJob } = await import("@/lib/jobs/runner");
const { listProducts } = await import("@/lib/domain/products/repository");
const { resolveSearchQuery } = await import("@/lib/domain/products/search-translation");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug,
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values,
  }).returning({ id: products.id });
  return row.id;
}

const answer = (en: string[], ko: string[]) => {
  const body = { choices: [{ message: { content: JSON.stringify({ keywords_en: en, keywords_ko: ko }) } }] };
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
};

const tick = () => runJob("product-search-profile", writeSearchProfiles);
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };

async function find(query: string): Promise<string[]> {
  const resolved = await resolveSearchQuery(query);
  return (await listProducts({ statuses: ["seeded", "verified"], sort: "relevance", limit: 10, query: resolved.queries })).map((row) => row.slug);
}

const gateway = vi.fn();

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(productSearchProfiles);
  await db.delete(jobs);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.execute(sql`truncate product_audit_campaigns, product_audit_items, product_audit_attempts restart identity cascade`);
  await db.delete(textTranslations).where(eq(textTranslations.targetLang, "en"));
  setServingContractSnapshotForTest([directContractRow("product-search-profile", PROFILE_MODEL)]);
  gateway.mockReset();
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });

describe("검색 키워드 잡", () => {
  it("키워드를 지어 원본과 색인용 사본을 같이 적는다", async () => {
    const id = await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    gateway.mockResolvedValue(answer(["grocery list", "shopping list"], ["장보기 목록", "쇼핑 리스트"]));

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ keywordsEn: ["grocery list", "shopping list"], keywordsKo: ["장보기 목록", "쇼핑 리스트"], errorCode: null });
    const [row] = await db.select({ keywords: products.searchKeywords }).from(products).where(eq(products.id, id));
    expect(row.keywords).toBe("grocery list · shopping list · 장보기 목록 · 쇼핑 리스트");
  });

  it("원본 변경은 30일을 기다리지 않고 재생성한다", async () => {
    const id = await seed("fresh");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(products).set({ tagline: "Workout diary", searchReadme: "Training logs" }).where(eq(products.id, id));
    gateway.mockClear();
    gateway.mockResolvedValue(answer(["workout diary"], ["운동 일지"]));
    await tick();
    expect(gateway).toHaveBeenCalledTimes(1);
    const [product] = await db.select().from(products).where(eq(products.id, id));
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ keywordsEn: ["workout diary"], sourceHash: profileHash(profileEvidence(product, null)) });
  });

  it("재생성이 실패해도 이전 키워드의 생성 해시를 덮어쓰지 않는다", async () => {
    const id = await seed("failure-provenance");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    const [before] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    await db.update(products).set({ tagline: "Workout diary" }).where(eq(products.id, id));
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);
    await tick();
    const [after] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(after).toMatchObject({ keywordsEn: before.keywordsEn, sourceHash: before.sourceHash, errorCode: "http_502" });
  });

  it("심사 메모도 자동 갱신하며 생성 도중 바뀐 메모의 응답은 저장하지 않는다", async () => {
    const id = await seed("notes");
    const [campaign] = await db.insert(productAuditCampaigns).values({ startedBy: "test", reason: "test", promptVersion: "v1", rulesVersion: "v1", provider: "test", model: "test" }).returning();
    const [note] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: id, slug: "notes", aiReason: "Shopping software" }).returning();
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(productAuditItems).set({ aiReason: "Workout software" }).where(eq(productAuditItems.id, note.id));
    expect(await pendingProfiles(10)).toHaveLength(1);
    expect(await pendingVerifications(10)).toHaveLength(0);
    let calls = 0;
    gateway.mockImplementation(async () => {
      if (calls++ === 0) {
        await db.update(productAuditItems).set({ aiReason: "Calendar software" }).where(eq(productAuditItems.id, note.id));
        return answer(["workout diary"], ["운동 일지"]);
      }
      return answer(["calendar"], ["달력"]);
    });
    await tick();
    const [saved] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(saved.keywordsEn).not.toContain("workout diary");
    expect(saved.sourceHash).not.toBe(profileHash(profileEvidence((await db.select().from(products).where(eq(products.id, id)))[0], "Workout software")));
  });

  it("복구는 기본 읽기 전용이며 해시만 바꾸지 않고 실제 재생성을 대기시킨다", async () => {
    const id = await seed("legacy-mismatch");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(productSearchProfiles).set({ sourceHash: "legacy-hash", needsRefresh: false }).where(eq(productSearchProfiles.productId, id));
    expect(await reconcileSearchProfileBatch({})).toMatchObject({ mismatched: 1, queued: 1 });
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0].needsRefresh).toBe(false);
    expect(await reconcileSearchProfileBatch({ apply: true })).toMatchObject({ mismatched: 1, queued: 1 });
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0])
      .toMatchObject({ sourceHash: "legacy-hash", needsRefresh: true });
    expect(await reconcileSearchProfileBatch({ apply: true })).toMatchObject({ queued: 0, alreadyPending: 1 });
    await tick();
    expect(await reconcileSearchProfileBatch({})).toMatchObject({ mismatched: 0 });
  });

  it("이전 빈 성공 응답은 명시적인 복구 시 같은 해시여도 다시 생성한다", async () => {
    const id = await seed("old-empty");
    gateway.mockResolvedValue(answer([], []));
    await tick();
    expect(await reconcileSearchProfileBatch({ apply: true, retryEmpty: true })).toMatchObject({ queued: 1 });
    gateway.mockClear();
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    expect(gateway).toHaveBeenCalledTimes(1);
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0].keywordsEn).toEqual(["grocery list"]);
  });

  it("이전 invalid_output 한도 초과를 생성/검수 각각 한 번 재개한다", async () => {
    const first = await seed("invalid-generation");
    const second = await seed("invalid-verification");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(productSearchProfiles).set({ errorCode: "invalid_output", attempts: 5 }).where(eq(productSearchProfiles.productId, first));
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 5 }).where(eq(productSearchProfiles.productId, second));
    expect(await reconcileSearchProfileBatch({ apply: true, retryInvalidOutput: true })).toMatchObject({ queued: 1, verificationRetried: 1 });
    expect(await pendingProfiles(10)).toHaveLength(1);
    expect(await pendingVerifications(10)).toHaveLength(1);
  });

  it("본문 뒷부분만 바뀌어 생성 입력은 같으면 모델 호출 없이 갱신 표시를 지운다", async () => {
    const id = await seed("unchanged-prefix", { searchPageText: "a".repeat(1500) + "old" });
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(products).set({ searchPageText: "a".repeat(1500) + "new" }).where(eq(products.id, id));
    gateway.mockClear();
    await tick();
    expect(gateway).not.toHaveBeenCalled();
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0].needsRefresh).toBe(false);
  });

  it("이미 갱신 대기 중인 한도 초과도 복구 캠페인에서 한 번만 재개한다", async () => {
    const id = await seed("capped-dirty");
    gateway.mockResolvedValue(answer([], []));
    await tick();
    await db.update(productSearchProfiles).set({ needsRefresh: true, errorCode: "invalid_output", attempts: 5 }).where(eq(productSearchProfiles.productId, id));
    expect(await reconcileSearchProfileBatch({ apply: true, retryInvalidOutput: true })).toMatchObject({ queued: 1 });
    await db.update(productSearchProfiles).set({ errorCode: "invalid_output", attempts: 5 }).where(eq(productSearchProfiles.productId, id));
    expect(await reconcileSearchProfileBatch({ apply: true, retryInvalidOutput: true })).toMatchObject({ queued: 0 });
  });

  it("재생성 결과가 정상 빈 배열이면 다음 복구 실행에서 다시 넣지 않는다", async () => {
    const id = await seed("valid-empty");
    gateway.mockResolvedValue(answer([], []));
    await tick();
    await reconcileSearchProfileBatch({ apply: true, retryEmpty: true });
    await tick();
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0]).toMatchObject({ needsRefresh: false, repairVersion: 1 });
    expect(await reconcileSearchProfileBatch({ apply: true, retryEmpty: true })).toMatchObject({ queued: 0 });
  });

  it("UTF-16 입력 범위 밖 변화는 실패 재시도 한도를 초기화하지 않는다", async () => {
    const prefix = "a".repeat(1498) + "😀";
    const id = await seed("capped-prefix", { searchPageText: prefix + "old" });
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);
    await tick();
    await db.update(productSearchProfiles).set({ attempts: 5 }).where(eq(productSearchProfiles.productId, id));
    await db.update(products).set({ searchPageText: prefix + "new" }).where(eq(products.id, id));
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0]).toMatchObject({ attempts: 5, needsRefresh: false });
    expect(await pendingProfiles(10)).toHaveLength(0);
    // A split surrogate has the same JS input if only the low surrogate differs.
    const split = "a".repeat(1499);
    const [{ equal }] = await db.execute(sql`select search_profile_prefix(${split + "😀"}, 1500) = search_profile_prefix(${split + "😁"}, 1500) as equal`) as unknown as { equal: boolean }[];
    expect(equal).toBe(true);
    const [{ different }] = await db.execute(sql`select search_profile_prefix(${split + "𰀀"}, 1500) <> search_profile_prefix(${split + "؀"}, 1500) as different`) as unknown as { different: boolean }[];
    expect(different).toBe(true);
  });

  it("관리자가 제품을 잠근 상태에서도 심사 메모 변경은 반대 잠금 순서로 막히지 않는다", async () => {
    const id = await seed("lock-order");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    const [campaign] = await db.insert(productAuditCampaigns).values({ startedBy: "test", reason: "test", promptVersion: "v1", rulesVersion: "v1", provider: "test", model: "test" }).returning();
    const [note] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: id, slug: "lock-order", aiReason: "Shopping software" }).returning();
    await db.transaction(async (admin) => {
      await admin.select().from(products).where(eq(products.id, id)).for("update");
      await db.transaction(async (reviewer) => {
        await reviewer.execute(sql`set local statement_timeout = '1s'`);
        await reviewer.update(productAuditItems).set({ aiReason: "Calendar software" }).where(eq(productAuditItems.id, note.id));
      });
      await admin.update(productAuditItems).set({ humanDecision: "removed" }).where(eq(productAuditItems.id, note.id));
    });
    expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0].needsRefresh).toBe(true);
  });

  it("한국어로 영어 제품을, 영어로 한국어 제품을 찾는다 — 번역 없이", async () => {
    await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    await seed("club-season", { name: "Club Season", tagline: "스쿼드를 만들고 리그를 오르는 축구 클럽 매니저", description: "스쿼드를 만들고 리그를 오르는 축구 클럽 매니저" });
    gateway.mockImplementation(async (_url: unknown, options?: RequestInit) => {
      if (typeof options?.body !== "string") throw new Error("unexpected_search_profile_body");
      const body = JSON.parse(options.body);
      const user = body.messages.find((message: { role: string }) => message.role === "user")?.content;
      const prefix = "<untrusted_evidence_json>\n", suffix = "\n</untrusted_evidence_json>";
      if (typeof user !== "string" || !user.startsWith(prefix) || !user.endsWith(suffix))
        throw new Error("unexpected_search_profile_evidence_envelope");
      const evidence = JSON.parse(user.slice(prefix.length, -suffix.length));
      if (evidence?.name === "Club Season") return answer(["soccer club manager", "football manager game"], ["축구 매니저 게임"]);
      if (evidence?.name === "Coche") return answer(["grocery list"], ["장보기 목록"]);
      throw new Error("unexpected_search_profile_product");
    });
    await tick();

    // 번역은 부르지 않는다(검색어 번역 경로의 직접 연결 계약이 없다) — 색인의 키워드만으로 찾혀야 한다
    gateway.mockClear();
    expect(await find("장보기 목록")).toContain("coche");
    expect(await find("football manager game")).toContain("club-season");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("지은 지 30일이 지나도 글이 그대로면 다시 부르지 않는다", async () => {
    const id = await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    gateway.mockClear();

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(Date.now() - profile.updatedAt.getTime()).toBeLessThan(24 * 3600_000);
  });

  it("빈 객체를 받은 경우 성공 프로필이나 검색 사본을 만들지 않는다", async () => {
    const id = await seed("empty-object");
    gateway.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) } as Response);
    await tick();
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ errorCode: "invalid_output", attempts: 1 });
    expect((await db.select().from(products).where(eq(products.id, id)))[0].searchKeywords).toBeNull();
  });

  it.each(["<html>proxy page</html>", "null", '{"choices":[{"message":{"content":{}}}]}'])
    ("a malformed HTTP 200 response reaches the quality cap through the normal leased writer: %s", async body => {
      const id = await seed("malformed-response");
      const [product] = await db.select().from(products).where(eq(products.id, id));
      await db.insert(productSearchProfiles).values({ productId: id,
        sourceHash: profileHash(profileEvidence(product, null)), attempts: 4, errorCode: "invalid_output", needsRefresh: true });
      gateway.mockResolvedValue({ ok: true, text: async () => body } as Response);
      await tick();
      expect((await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0])
        .toMatchObject({ attempts: 5, errorCode: "invalid_output", repairVersion: 0 });
      expect(await pendingProfiles(10)).toHaveLength(0);
      expect((await db.select().from(products).where(eq(products.id, id)))[0].searchKeywords).toBeNull();
    });

  it("실패는 다시 볼 시각을 달고 남는다 — 색인용 사본은 비운 채로", async () => {
    const id = await seed("coche");
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);

    await tick();

    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ errorCode: "http_502", attempts: 1 });
    expect(profile.retryAt).not.toBeNull();
    const [row] = await db.select({ keywords: products.searchKeywords }).from(products).where(eq(products.id, id));
    expect(row.keywords).toBeNull();
  });

  // 2026-10-31 결정: 한 건이 오래 걸려도 틱을 접지 않는다(slowCallMs 양보 삭제) — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다. 1차 심사와의 장비 나눔은 장비 순위(PR 1b)가 한다
  it("한 건이 오래 걸려도 그 틱을 접지 않는다 — 나머지를 계속 짓는다", async () => {
    for (const slug of ["first", "second", "third", "fourth"]) await seed(slug);
    vi.useFakeTimers({ toFake: ["Date"] });
    // 첫 호출만 느리다(예전의 느린 호출 문턱 20초를 넘긴다) — 그래도 나머지 셋을 모두 짓는다
    let calls = 0;
    gateway.mockImplementation(async () => {
      if (calls++ === 0) vi.setSystemTime(Date.now() + 20_000);
      return answer(["grocery list"], ["장보기"]);
    });

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    expect(gateway).toHaveBeenCalledTimes(4);
    expect(await db.select().from(productSearchProfiles)).toHaveLength(4);
  });

  it("안 지은 것 다음에는 오래 기다린 갱신부터 짓는다 — 최근 제품이 앞을 차지하지 않게", async () => {
    const waited = await seed("waited");
    const recent = await seed("recent");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(products).set({ tagline: "changed" });
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '14 days'` }).where(eq(productSearchProfiles.productId, waited));
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '1 hour'` }).where(eq(productSearchProfiles.productId, recent));
    const rich = await seed("new-rich", { description: "A longer description" });
    const thin = await seed("new-thin");

    expect((await pendingProfiles(10)).map((task) => task.product.id)).toEqual([thin, rich, waited, recent]);
  });

  it("새 제품이 계속 들어와도 오래 기다린 제품이 묶음에서 빠지지 않는다", async () => {
    const old = await seed("old-waiting", { createdAt: sql`now() - interval '10 days'` as unknown as Date });
    // 우선순위 줄(안 지은 것 안에서 새 제품 먼저)만 보면 이 12건이 매번 앞을 차지한다
    for (let index = 0; index < 13; index++) await seed(`arrival-${index}`);
    const batch = (await pendingProfiles(12)).map((task) => task.product.id);
    expect(batch).toHaveLength(12);
    // 우선순위 둘 다음 셋째 — 둘씩 동시에 부르므로 둘째 차례에 간다
    expect(batch[2]).toBe(old);
    expect(new Set(batch).size).toBe(12);
  });

  it("실패를 되풀이하는 제품은 오래 기다린 몫만 쓰고, 다시 실패하면 그 몫에서도 뒤로 간다", async () => {
    const failing: number[] = [];
    for (let index = 0; index < 8; index++) {
      const id = await seed(`provider-failing-${index}`, { createdAt: sql`now() - interval '20 days'` as unknown as Date });
      await db.insert(productSearchProfiles).values({ productId: id, sourceHash: "old", errorCode: "rate_limit", attempts: 40,
        retryAt: sql`now() - interval '1 minute'`, updatedAt: sql`now() - interval '19 days'` });
      failing.push(id);
    }
    const fresh: number[] = [];
    for (let index = 0; index < 10; index++) fresh.push(await seed(`fresh-${index}`));
    const first = (await pendingProfiles(12)).map((task) => task.product.id);
    // 4건은 오래 기다린 실패, 8건은 우선순위 줄의 안 지은 것 — 실패가 묶음을 채우지 않는다
    expect(first.filter((id) => failing.includes(id))).toEqual(failing.slice(0, 4));
    expect(first.filter((id) => fresh.includes(id))).toHaveLength(8);
    // 다시 실패하면 할 일이 된 시각이 재시도 시각으로 밀려 같은 넷이 다음 묶음을 차지하지 않는다
    await db.update(productSearchProfiles).set({ updatedAt: sql`now()`, retryAt: sql`now() - interval '1 second'` })
      .where(inArray(productSearchProfiles.productId, failing.slice(0, 4)));
    const next = (await pendingProfiles(12)).map((task) => task.product.id);
    expect(next.filter((id) => failing.includes(id))).toEqual(failing.slice(4, 8));
  });

  it("감사가 공개분을 다시 돌아도 방금 바뀐 메모가 먼저 기다린 갱신을 앞지르지 않는다", async () => {
    const waiting = await seed("waiting");
    const edited = await seed("edited");
    const swept = await seed("swept");
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    const [campaign] = await db.insert(productAuditCampaigns).values({ startedBy: "test", reason: "test", promptVersion: "v1", rulesVersion: "v1", provider: "test", model: "test" }).returning();
    // 이틀 전에 지었고 20시간 전 감사로 메모가 바뀌어 기다리는 중
    await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: waiting, slug: "waiting", aiReason: "Older note", reviewedAt: sql`now() - interval '20 hours'` });
    // 한 시간 전에 지었고 그 뒤 글이 바뀜(바뀐 때는 모른다)
    await db.update(products).set({ tagline: "changed" }).where(eq(products.id, edited));
    // 20일 전에 지었고 방금 감사로 메모가 바뀜
    await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: swept, slug: "swept", aiReason: "Sweep note", reviewedAt: sql`now()` });
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '2 days'` }).where(eq(productSearchProfiles.productId, waiting));
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '1 hour'` }).where(eq(productSearchProfiles.productId, edited));
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '20 days'` }).where(eq(productSearchProfiles.productId, swept));

    expect((await pendingProfiles(10)).map((task) => task.product.id)).toEqual([waiting, edited, swept]);
  });

  it("공개되지 않은 제품은 짓지 않는다", async () => {
    await seed("hidden", { status: "banned" });
    await tick();
    expect(gateway).not.toHaveBeenCalled();
  });

  it("직접 연결 계약이 없으면 부르지 않고 no_direct_contract 로 넘긴다 — 성공이 아니다", async () => {
    const id = await seed("no-contract");
    setServingContractSnapshotForTest([]);
    expect(await tick()).toMatchObject({ status: "completed", done: true, degraded: "no_direct_contract" });
    expect(gateway).not.toHaveBeenCalled();
    expect(await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id))).toEqual([]);
  });

  it("옛 잎(writeKeywords)은 계약이 있어도 게이트웨이로 보내지 않고 no_key 로 끝난다", async () => {
    const id = await seed("real-leaf");
    const [product] = await db.select().from(products).where(eq(products.id, id));
    const real = await vi.importActual<typeof import("@/lib/domain/products/search-profile")>("@/lib/domain/products/search-profile");
    expect(await real.writeKeywords(profileEvidence(product, null), { timeoutMs: 1_000, request: gateway })).toEqual({ ok: false, error: "no_key" });
    expect(gateway).not.toHaveBeenCalled();
  });
});

describe("카테고리 색인", () => {
  it("카테고리의 한국어 이름으로도 찾는다", async () => {
    await seed("rookies-revenge", { name: "Rookie's Revenge", tagline: "A daily chess roguelike", description: "A daily chess roguelike", category: "Games" });
    await refreshProductSearchDocuments(ctx);

    const [row] = await db.select({ category: products.searchCategory }).from(products).where(eq(products.slug, "rookies-revenge"));
    expect(row.category).toBe("Games 게임");
    // 소개에 "game"이 없어도 카테고리가 잇는다
    expect(await find("chess game")).toContain("rookies-revenge");
    expect(await find("게임")).toContain("rookies-revenge");
  });
});

describe("본문 옮겨 적기와 키워드 갱신", () => {
  async function crawled(slug: string, textSample: string) {
    const id = await seed(slug, { searchPageText: textSample });
    await db.insert(crawlDocuments).values({ repo: `owner/${slug}`, productUrl: `https://${slug}.test`, pageStatus: 200,
      repoMeta: { topics: ["pdf"] }, pageMeta: { textSample } });
    await db.insert(crawlCandidates).values({ repo: `owner/${slug}`, state: "published", publishedSlug: slug });
    await refreshProductSearchDocuments(ctx);
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    return id;
  }
  // 생존 확인이 본문을 새로 떠 온 것과 같다(uptime.ts → refreshTextSample)
  const resample = (slug: string, textSample: string) => db.update(crawlDocuments)
    .set({ pageMeta: { textSample } }).where(eq(crawlDocuments.repo, `owner/${slug}`));
  const state = async (id: number) => {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    return { pageText: product.searchPageText, topics: product.searchTopics, needsRefresh: profile.needsRefresh };
  };

  it("지은 지 일주일이 안 됐으면 본문만 바뀐 것은 옮기지 않아 다시 짓지 않는다", async () => {
    const id = await crawled("visits", "Ranking · 2,798 visits");
    await resample("visits", "Ranking · 2,812 visits");
    await refreshProductSearchDocuments(ctx);
    expect(await state(id)).toMatchObject({ pageText: "Ranking · 2,798 visits", needsRefresh: false });
    gateway.mockClear();
    await tick();
    expect(gateway).not.toHaveBeenCalled();
  });

  it("일주일이 지나면 바뀐 본문을 옮기고 다시 짓는다", async () => {
    const id = await crawled("weekly", "Ranking · 2,798 visits");
    await db.update(productSearchProfiles).set({ generatedAt: sql`now() - interval '8 days'` }).where(eq(productSearchProfiles.productId, id));
    await resample("weekly", "Ranking · 9,999 visits");
    await refreshProductSearchDocuments(ctx);
    expect(await state(id)).toMatchObject({ pageText: "Ranking · 9,999 visits", needsRefresh: true });
  });

  it("본문 말고 다른 원본이 바뀌면 바로 옮기고 다시 짓는다 — 본문도 같이", async () => {
    const id = await crawled("topics", "Merge PDF files");
    await db.update(crawlDocuments).set({ repoMeta: { topics: ["pdf", "cli"] }, pageMeta: { textSample: "Merge PDF files fast" } })
      .where(eq(crawlDocuments.repo, "owner/topics"));
    await refreshProductSearchDocuments(ctx);
    expect(await state(id)).toMatchObject({ topics: "pdf cli", pageText: "Merge PDF files fast", needsRefresh: true });
  });

  it("비었던 본문이 생기거나, 다른 원인으로 다시 지을 차례면 본문을 바로 옮긴다", async () => {
    const empty = await crawled("empty", "");
    const pending = await crawled("pending", "Merge PDF files");
    await resample("empty", "Merge PDF files");
    await db.update(products).set({ tagline: "PDF merger" }).where(eq(products.id, pending));
    await resample("pending", "Merge PDF files fast");
    await refreshProductSearchDocuments(ctx);
    expect(await state(empty)).toMatchObject({ pageText: "Merge PDF files", needsRefresh: true });
    expect(await state(pending)).toMatchObject({ pageText: "Merge PDF files fast", needsRefresh: true });
  });
});

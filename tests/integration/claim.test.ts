import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: vi.fn().mockResolvedValue(null),
  readBodyCapped: vi.fn(),
}));

const repo = await import("@/lib/domain/products/repository");
const { verifyProduct } = await import("@/lib/domain/products/verify");
const { registerProduct } = await import("@/lib/domain/products/register");
const { updateProduct } = await import("@/lib/domain/products/manage");
const { isUnclaimed } = await import("@/lib/domain/products/view");
const { ensureSchema, resetTables } = await import("./setup");

const SEED_TOKEN = "nmv_verify_found_app";

/** 수집기가 올린 제품 — 수정 키는 아무도 쥐고 있지 않다 */
async function seeded(slug = "found-app", url = "https://found.test") {
  await repo.insert({
    slug,
    url,
    name: "FoundApp",
    tagline: "수집된 소개",
    description: "공개 저장소에서 찾은 제품입니다.",
    category: "Other",
    stack: [],
    status: "seeded",
    source: "crawler",
    verifyToken: SEED_TOKEN,
    // 발행할 때 만들어 버린 값 — 이 해시에 맞는 키는 세상에 없다
    editTokenHash: "x".repeat(64),
  });
}

/** 도메인에 검증 파일이 올라간 상태 */
function domainProves(token: string) {
  fetchPage.mockResolvedValueOnce({ status: 200, html: token });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  fetchPage.mockReset();
});

describe("클레임 — 우리가 대신 올린 제품 가져가기", () => {
  it("도메인을 증명하면 주인이 된다", async () => {
    await seeded();
    domainProves(SEED_TOKEN);

    const result = await verifyProduct("found-app");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ status: "verified", claimed: true });
    expect(result.value.edit_token).toBeTruthy();

    const product = await repo.findBySlug("found-app");
    expect(product?.claimedAt).toBeInstanceOf(Date);
    expect(isUnclaimed(product!)).toBe(false);
    // 어디서 왔는지는 클레임 후에도 남는다
    expect(product?.source).toBe("crawler");
  });

  it("클레임 전에는 아무도 수정할 수 없다", async () => {
    await seeded();

    const result = await updateProduct("found-app", { editToken: "아무 키나" }, { name: "가로채기" });

    // 발행 때 만든 해시에 맞는 키가 없으므로 어떤 키를 들이대도 통하지 않는다
    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("클레임하며 받은 키로 수정할 수 있다", async () => {
    await seeded();
    domainProves(SEED_TOKEN);
    const claim = await verifyProduct("found-app");
    if (!claim.ok || !claim.value.edit_token) throw new Error("사전 조건 실패");

    const result = await updateProduct(
      "found-app",
      { editToken: claim.value.edit_token },
      { name: "제대로 된 이름", builder: "Claude Code" },
    );

    expect(result.ok).toBe(true);
    const product = await repo.findBySlug("found-app");
    // "만든 AI"는 주인이 나타난 지금 처음 채워진다 — 우리가 추측해 넣지 않았다
    expect(product).toMatchObject({ name: "제대로 된 이름", builder: "Claude Code" });
  });

  it("증명하지 못하면 아무것도 넘어가지 않는다", async () => {
    await seeded();
    fetchPage.mockResolvedValue({ status: 404, html: "" });

    const result = await verifyProduct("found-app");

    expect(result).toMatchObject({ ok: false, error: { kind: "verification_failed" } });
    const product = await repo.findBySlug("found-app");
    expect(product).toMatchObject({ status: "seeded", claimedAt: null });
  });

  it("이미 클레임한 제품을 다시 검증해도 키를 새로 주지 않는다", async () => {
    await seeded();
    domainProves(SEED_TOKEN);
    const first = await verifyProduct("found-app");
    if (!first.ok) throw new Error("사전 조건 실패");

    const second = await verifyProduct("found-app");

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toMatchObject({ already: true });
    expect(second.value.edit_token).toBeUndefined();

    // 처음 받은 키는 그대로 살아 있다
    const stillWorks = await updateProduct(
      "found-app",
      { editToken: first.value.edit_token! },
      { name: "그대로" },
    );
    expect(stillWorks.ok).toBe(true);
  });

  it("메이커가 등록한 제품의 검증은 클레임이 아니다", async () => {
    fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
    const registered = await registerProduct({
      url: "https://mine.test",
      name: "MyApp",
      tagline: "메이커가 쓴 소개",
      description: "직접 등록했다.",
      category: "Other",
    });
    if (!registered.ok) throw new Error("사전 조건 실패");

    domainProves(registered.value.verifyToken);
    const result = await verifyProduct(registered.value.slug);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 등록할 때 이미 키를 받았다 — 여기서 다시 발급하면 기존 키가 죽는다
    expect(result.value.edit_token).toBeUndefined();
    expect(result.value.claimed).toBeUndefined();
    expect((await repo.findBySlug(registered.value.slug))?.claimedAt).toBeNull();
  });
});

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { takedownRequests } from "@/lib/db/schema";
import * as repo from "@/lib/domain/products/repository";
import { requestTakedown, pendingTakedowns, resolveTakedown } from "@/lib/domain/products/takedown";
import { ensureSchema, resetTables } from "./setup";

/** 우리가 대신 올린 제품 — 주인이 부탁한 적이 없다 */
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
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(takedownRequests);
  await resetTables();
});

describe("내려달라는 요청", () => {
  it("소유 증명 없이 받는다 — 내려달라는 사람에게 토큰을 붙이라 할 수는 없다", async () => {
    await seeded();

    expect(await requestTakedown("found-app", "제 프로젝트인데 공개를 원치 않습니다")).toMatchObject({
      ok: true,
    });

    const [request] = await pendingTakedowns();
    expect(request).toMatchObject({ slug: "found-app", reason: "제 프로젝트인데 공개를 원치 않습니다" });
  });

  it("이유 없이도 받는다 — 이유를 대야 내려준다면 조건부 약속이 된다", async () => {
    await seeded();
    expect(await requestTakedown("found-app")).toMatchObject({ ok: true });
    expect((await pendingTakedowns())[0].reason).toBeNull();
  });

  it("같은 제품에 여러 번 와도 큐에는 하나만 남는다", async () => {
    await seeded();
    await requestTakedown("found-app", "첫 요청");
    await requestTakedown("found-app", "두 번째 요청");

    const pending = await pendingTakedowns();
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe("두 번째 요청");
  });

  it("주인이 있는 제품은 이 창구가 아니다", async () => {
    // 남이 멀쩡한 제품을 흔드는 길이 되면 안 된다. 주인은 수정 키로 스스로 지운다
    await repo.insert({
      slug: "my-app",
      url: "https://mine.test",
      name: "MyApp",
      tagline: "메이커가 쓴 소개",
      description: "직접 등록했다.",
      category: "Other",
      stack: [],
      status: "verified",
      source: "skill",
      verifyToken: "nmv_verify_mine",
      editTokenHash: "y".repeat(64),
    });

    expect(await requestTakedown("my-app", "내려주세요")).toMatchObject({
      ok: false,
      error: { kind: "forbidden" },
    });
  });

  it("내리면 행은 남고 차단된다 — 지우면 수집기가 다시 주워 온다", async () => {
    await seeded();
    await requestTakedown("found-app", "내려주세요");

    expect(await resolveTakedown("found-app", "remove", "jr")).toMatchObject({ ok: true });

    const product = await repo.findBySlug("found-app");
    expect(product?.status).toBe("banned");
    expect(await pendingTakedowns()).toHaveLength(0);
  });

  it("두고 보기로 하면 제품은 그대로 두고 요청만 닫는다", async () => {
    await seeded();
    await requestTakedown("found-app");

    await resolveTakedown("found-app", "dismiss", "jr");

    expect((await repo.findBySlug("found-app"))?.status).toBe("seeded");
    expect(await pendingTakedowns()).toHaveLength(0);
  });

  it("차단된 제품에는 다시 요청할 수 없다", async () => {
    await seeded();
    await requestTakedown("found-app");
    await resolveTakedown("found-app", "remove", "jr");

    expect(await requestTakedown("found-app")).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });

  it("이미 처리한 요청은 다시 처리하지 않는다", async () => {
    await seeded();
    await requestTakedown("found-app");
    await resolveTakedown("found-app", "dismiss", "jr");

    expect(await resolveTakedown("found-app", "remove", "jr")).toMatchObject({ ok: false });
  });
});

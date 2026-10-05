import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { productClickDaily, takedownRequests } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import * as repo from "@/lib/domain/products/repository";
import { requestTakedown, pendingTakedowns, resolveTakedown, resolveTakedowns, takedownHistory, takedownQueue, takedownRequesterHash,
  takedownSummary } from "@/lib/domain/products/takedown";
import { productVisitorHash } from "@/lib/domain/products/visitors";
import { ensureSchema, resetTables } from "./setup";

/** 우리가 대신 올린 제품 — 주인이 부탁한 적이 없다 */
async function seeded(slug = "found-app", url = "https://found.test", repoUrl: string | null = null) {
  await repo.insert({
    repoUrl,
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

  it("동시에 기각과 내리기를 눌러도 한 처리만 성공하고 제품 상태와 일치한다", async () => {
    await seeded();
    await requestTakedown("found-app");
    const results = await Promise.all([
      resolveTakedown("found-app", "remove", "remove-admin"),
      resolveTakedown("found-app", "dismiss", "dismiss-admin"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const [request] = await db.select().from(takedownRequests);
    expect((await repo.findBySlug("found-app"))?.status).toBe(request.outcome === "removed" ? "banned" : "seeded");
  });
});

describe("처리 화면 — 보낸이·계정·이력", () => {
  const SECRET = "s".repeat(40);
  /** 요청 시각을 직접 옮긴다 — 기다린 시간·몰림을 재려고 */
  const backdate = (slug: string, hours: number) =>
    db.execute(sql`update takedown_requests set requested_at = (current_timestamp at time zone 'UTC') - ${hours} * interval '1 hour' where slug = ${slug}`);

  it("보낸이는 해시로만 남고 방문자 해시와 섞이지 않으며, 주소를 모르면 비운다", async () => {
    const hash = takedownRequesterHash("203.0.113.7", SECRET)!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(takedownRequesterHash("203.0.113.7", SECRET));
    expect(hash).not.toBe(takedownRequesterHash("203.0.113.8", SECRET));
    expect(hash).not.toBe(productVisitorHash("takedown", "203.0.113.7", SECRET));
    expect(takedownRequesterHash(null, SECRET)).toBeNull();
    expect(takedownRequesterHash("203.0.113.7", "short")).toBeNull();
    await seeded();
    await requestTakedown("found-app", "내려 주세요", hash);
    expect((await pendingTakedowns())[0].requesterHash).toBe(hash);
  });

  it("다시 요청하면 수를 세고, 전에 처리한 결과를 남기며 처리 칸은 비운다", async () => {
    await seeded();
    await requestTakedown("found-app", "첫 요청");
    await resolveTakedown("found-app", "dismiss", "jr", { dismissReason: "test_spam", note: "테스트" });
    await requestTakedown("found-app", "진짜 요청");
    const [row] = await db.select().from(takedownRequests);
    expect(row).toMatchObject({ requestCount: 2, previousOutcome: "dismissed", handledAt: null, outcome: null, dismissReason: null, note: null, reason: "진짜 요청" });
  });

  it("둘 때는 고른 이유와 메모가 남고, 모르는 이유는 받지 않는다", async () => {
    await seeded();
    await requestTakedown("found-app");
    expect(await resolveTakedown("found-app", "dismiss", "jr", { dismissReason: "nope" as never })).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(await resolveTakedown("found-app", "dismiss", "jr", { dismissReason: "not_owner", note: "  저장소 주인이 아닌 듯  " })).toMatchObject({ ok: true });
    const [history] = await takedownHistory();
    expect(history).toMatchObject({ slug: "found-app", outcome: "dismissed", dismissReason: "not_owner", note: "저장소 주인이 아닌 듯", handledBy: "jr" });
  });

  it("처리 줄에 계정·보낸이·방문을 붙이고 오래 기다린 것부터 준다", async () => {
    await seeded("a1", "https://a1.test", "https://github.com/Maker/one");
    await seeded("a2", "https://a2.test", "https://github.com/maker/two");
    await seeded("a3", "https://a3.test", "https://github.com/maker/three");
    await seeded("b1", "https://b1.test", "https://github.com/other/app");
    await seeded("c1", "https://c1.test");
    const sender = takedownRequesterHash("198.51.100.1", SECRET);
    await requestTakedown("a1", "모두 내려 주세요", sender);
    await requestTakedown("a2", null, sender);
    await requestTakedown("b1", "test", sender);
    await requestTakedown("c1", null, null);
    await backdate("a1", 30);
    await backdate("a2", 5);
    await db.insert(productClickDaily).values([{ slug: "a1", day: sql`current_date` as never, clicks: 9, uniqueVisitors: 7 },
      { slug: "a1", day: sql`current_date - 20` as never, clicks: 50, uniqueVisitors: 40 }]);
    const queue = await takedownQueue();
    expect(queue.map((entry) => entry.slug)).toEqual(["a1", "a2", "b1", "c1"]);
    const a1 = queue[0];
    expect(a1).toMatchObject({ owner: "maker", ownerPublic: 3, ownerPending: 2, senderPending: 3, visits7d: 7, requestCount: 1 });
    expect(a1.ageHours).toBeGreaterThan(29);
    expect(a1.requestedAt).toMatch(/Z$/);
    expect(a1.product?.name).toBe("FoundApp");
    expect(queue[3]).toMatchObject({ owner: null, ownerPublic: 0, senderPending: 0, requesterHash: null });
  });

  it("요약은 24시간 넘은 것·몰림·처리 수를 센다", async () => {
    for (let i = 0; i < 11; i++) await seeded(`p${i}`, `https://p${i}.test`, `https://github.com/acct${i}/x`);
    for (let i = 0; i < 11; i++) await requestTakedown(`p${i}`, i < 3 ? "test" : null, takedownRequesterHash(i < 6 ? "10.0.0.1" : "10.0.0.2", SECRET));
    await backdate("p0", 26);
    await resolveTakedown("p1", "remove", "jr");
    await resolveTakedown("p2", "dismiss", "jr", { dismissReason: "test_spam" });
    const summary = await takedownSummary();
    expect(summary).toMatchObject({ pending: 9, overdue: 1, handled24h: { removed: 1, dismissed: 1 }, last30d: { removed: 1, dismissed: 1 } });
    expect(summary.oldestHours).toBeGreaterThan(25);
    expect(summary.lastHour).toMatchObject({ requests: 10, owners: 10, senders: 2, noReason: 8, topReason: { text: "test", count: 2 } });
  });

  it("여러 건을 한 번에 — 그 사이 처리된 것만 실패로 돌려준다", async () => {
    await seeded("x1", "https://x1.test");
    await seeded("x2", "https://x2.test");
    await requestTakedown("x1");
    await requestTakedown("x2");
    await resolveTakedown("x2", "dismiss", "other-admin");
    const result = await resolveTakedowns(["x1", "x2", "x1"], "remove", "jr");
    expect(result.done).toEqual(["x1"]);
    expect(result.failed).toEqual([{ slug: "x2", message: "이미 처리됐거나 제품이 없습니다" }]);
    expect((await repo.findBySlug("x1"))?.status).toBe("banned");
  });
});

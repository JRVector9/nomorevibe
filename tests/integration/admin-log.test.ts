import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsAudit, takedownRequests } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import * as repo from "@/lib/domain/products/repository";
import { requestTakedown, resolveTakedown, takedownHistory } from "@/lib/domain/products/takedown";
import { adminLog, recordAdminAction } from "@/lib/operations/admin-log";
import { ensureSchema, resetTables } from "./setup";

/** 작업 로그는 지울 수 없어 테스트 사이에 남는다 — 대상마다 이번 실행만의 이름을 붙여 가른다 */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const target = (name: string) => `${name}-${RUN}`;
const rowsFor = (name: string) => db.select().from(operationsAudit).where(eq(operationsAudit.target, name)).orderBy(desc(operationsAudit.id));

beforeAll(() => ensureSchema());
afterEach(() => vi.unstubAllEnvs());

describe("관리자 작업 로그", () => {
  it("덧붙이기만 한다 — 고치기·지우기·비우기를 DB가 거부한다", async () => {
    const name = target("append-only");
    await recordAdminAction("jr", { action: "product-ban", target: name });
    const [row] = await rowsFor(name);
    expect(row).toMatchObject({ actor: "jr", actorKind: "github", ok: true, error: null });

    await expect(db.update(operationsAudit).set({ actor: "someone-else" }).where(eq(operationsAudit.id, row.id))).rejects.toThrow();
    await expect(db.delete(operationsAudit).where(eq(operationsAudit.id, row.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE operations_audit`)).rejects.toThrow();
    expect(await rowsFor(name)).toEqual([row]);
  });

  it("로컬 로그인은 'local' 로, 실패는 실패로 남긴다", async () => {
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "1");
    const name = target("failed");
    await recordAdminAction("local", { action: "product-ban", target: name, ok: false, error: "x".repeat(400) });
    const [row] = await rowsFor(name);
    expect(row).toMatchObject({ actor: "local", actorKind: "local", ok: false });
    expect(row.error).toHaveLength(300);
    // 요청 밖(테스트·워커)에서는 접속 주소를 모른다
    expect(row.ip).toBeNull();

    expect((await adminLog({ actions: ["product-ban"], failedOnly: true })).map((item) => item.target)).toContain(name);
    expect((await adminLog({ actions: ["product-ban"], failedOnly: true })).every((item) => !item.ok)).toBe(true);
  });
});

describe("설정 저장 기록", () => {
  beforeEach(() => db.delete(crawlSettings));
  afterAll(() => db.delete(crawlSettings));
  const latestSettingsRow = async () => (await db.select().from(operationsAudit)
    .where(eq(operationsAudit.action, "settings-save")).orderBy(desc(operationsAudit.id)).limit(1))[0];

  it("바뀐 값만 전과 후로 남기고, 거절된 저장도 남긴다", async () => {
    const actor = target("settings");
    expect(await saveSettings({ judge: { minStars: 7 } }, actor)).toMatchObject({ ok: true });
    const saved = await latestSettingsRow();
    expect(saved).toMatchObject({ actor, ok: true, target: "crawl_settings" });
    expect(saved.detail.changes).toEqual([{ path: "judge.minStars", before: expect.any(Number), after: 7 }]);

    expect(await saveSettings({ judge: { minStars: -1 } }, actor)).toMatchObject({ ok: false });
    const rejected = await latestSettingsRow();
    expect(rejected).toMatchObject({ actor, ok: false });
    expect(rejected.error).toContain("minStars");
  });
});

describe("내려달라는 요청 처리 기록", () => {
  beforeEach(async () => {
    await db.delete(takedownRequests);
    await resetTables();
  });

  it("다시 요청이 와서 요청 행이 덮여도 처리할 때마다 한 줄씩 남는다", async () => {
    const slug = target("td").slice(0, 60);
    await repo.insert({
      repoUrl: null, slug, url: `https://${slug}.test`, name: "LogApp", tagline: "수집된 소개", description: "공개 저장소에서 찾은 제품입니다.",
      category: "Other", stack: [], status: "seeded", source: "crawler", verifyToken: `nmv_verify_${slug}`, editTokenHash: "x".repeat(64),
    });
    await requestTakedown(slug, "처음 요청");
    expect(await resolveTakedown(slug, "dismiss", "jr", { dismissReason: "test_spam", note: "장난" })).toMatchObject({ ok: true });
    await requestTakedown(slug, "다시 요청");
    expect(await resolveTakedown(slug, "remove", "jr")).toMatchObject({ ok: true });

    const history = (await takedownHistory(500)).filter((row) => row.slug === slug);
    expect(history).toMatchObject([
      { outcome: "removed", reason: "다시 요청", requestCount: 2, handledBy: "jr", name: "LogApp" },
      { outcome: "dismissed", reason: "처음 요청", requestCount: 1, dismissReason: "test_spam", note: "장난", handledBy: "jr" },
    ]);
    // 요청 행은 마지막 처리만 갖는다 — 처리 기록이 로그에서 오는 이유
    const [request] = await db.select().from(takedownRequests).where(eq(takedownRequests.slug, slug));
    expect(request).toMatchObject({ outcome: "removed", previousOutcome: "dismissed" });
  });
});

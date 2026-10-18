import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings } from "@/lib/db/schema";
import { getSettings, saveSettings, setSourceBufferEnabled } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(crawlSettings); });

const control = async () => (await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(t) AS value FROM crawl_source_buffer_control t`)).map(row => row.value);

/**
 * 원본 공급 조절 스위치(ops-v8 PR8) — 잠근 설정 행에서 compare-and-set 으로 enabled 하나만 바꾸고, 전·후·사유를 작업 로그에 남긴다.
 * 판정 상태 행(crawl_source_buffer_control)은 수집 잡만 쓴다.
 */
describe("원본 공급 조절 켜기·끄기", () => {
  it("배포만으로는 꺼져 있다 — 기본값은 지금과 같다", async () => {
    expect((await getSettings()).discover.sourceBuffer.enabled).toBe(false);
  });

  it("화면이 본 값이 맞으면 그 값 하나만 바꾸고 전·후·사유를 남긴다", async () => {
    await saveSettings({ judge: { maxStars: 500 }, enabled: true }, "fixture");
    const before = await getSettings(), floor = await auditFloor(), controlBefore = await control();
    expect(await setSourceBufferEnabled({ enabled: true, expectedEnabled: false, actor: "jr", reason: "후단 적체 시험" })).toEqual({ ok: true });
    const after = await getSettings();
    expect(after).toEqual({ ...before, discover: { ...before.discover, sourceBuffer: { enabled: true } } });
    const [row] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    expect(row.updatedBy).toBe("jr");
    const audit = await auditRowsAfter(floor, "source-buffer");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target: "crawl_settings", ok: true, error: null,
      detail: { before: false, after: true, expected: false, requested: true, reason: "후단 적체 시험" } });
    expect(await control()).toEqual(controlBefore);

    expect(await setSourceBufferEnabled({ enabled: false, expectedEnabled: true, actor: "jr", reason: "시험 끝" })).toEqual({ ok: true });
    expect((await getSettings()).discover.sourceBuffer.enabled).toBe(false);
  });

  it("그 사이 바뀌었으면 쓰지 않고 실패 줄만 남긴다", async () => {
    await setSourceBufferEnabled({ enabled: true, expectedEnabled: false, actor: "a", reason: "먼저" });
    const floor = await auditFloor();
    const stale = await setSourceBufferEnabled({ enabled: true, expectedEnabled: false, actor: "b", reason: "옛 화면" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issues.join()).toContain("그 사이");
    expect((await getSettings()).discover.sourceBuffer.enabled).toBe(true);
    const [row] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    expect(row.updatedBy).toBe("a");
    expect(await auditRowsAfter(floor, "source-buffer")).toMatchObject([{ ok: false, error: "stale_state",
      detail: { before: true, after: true, expected: false, requested: true, reason: "옛 화면" } }]);
  });

  it("저장된 설정이 깨져 기본값으로 읽히면 덮어쓰지 않는다", async () => {
    const broken = { ...DEFAULT_CRAWL_SETTINGS, judge: { ...DEFAULT_CRAWL_SETTINGS.judge, maxStars: -1 } };
    await db.insert(crawlSettings).values({ id: 1, values: broken, updatedBy: "fixture" });
    const floor = await auditFloor();
    const result = await setSourceBufferEnabled({ enabled: true, expectedEnabled: false, actor: "jr", reason: "시험" });
    expect(result.ok).toBe(false);
    const [row] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    expect(row.values).toEqual(broken);
    expect(row.updatedBy).toBe("fixture");
    expect(await auditRowsAfter(floor, "source-buffer")).toMatchObject([{ ok: false, error: "settings_unreadable" }]);
  });
});

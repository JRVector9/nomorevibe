import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsObservations } from "@/lib/db/schema";
import { getSettings, resetSettings, saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { lastSettingsRead } from "@/lib/crawl/settings-version";
import { observe } from "@/lib/operations/observations";
import { readSettingsApply } from "@/lib/operations/settings-apply";
import { ensureSchema } from "./setup";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: vi.fn().mockResolvedValue({ login: "jr" }) }));
const { saveCrawlSettings } = await import("@/app/admin/actions");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlSettings);
  await db.delete(operationsObservations).where(like(operationsObservations.key, "service:%"));
});

/** 워커가 하는 일 그대로 — 잡이 getSettings 로 읽고, 감시 프로세스가 마지막으로 읽은 판을 관측에 싣는다 */
async function workerTick(role: string, instance = "test") {
  await getSettings();
  const read = lastSettingsRead()!;
  await observe(`service:${role}:${instance}`, { role, status: "running", settingsVersion: read.version, settingsReadAt: read.at });
}

describe("설정 적용 확인(ADM-19)", () => {
  it("읽은 역할은 저장 판과 같고, 새로 저장하면 다시 읽기 전까지 대기, 10분이 지나면 조치할 일", async () => {
    await saveSettings({ discover: { windowDays: 9 } }, "admin");
    await workerTick("crawler");
    await observe("service:reviewer:test", { role: "reviewer", status: "running" }); // 판을 싣지 않는 옛 워커

    let apply = await readSettingsApply();
    expect(apply.roles.find((role) => role.role === "crawler")).toMatchObject({ state: "applied", reportedVersion: apply.savedVersion });
    expect(apply.roles.find((role) => role.role === "reviewer")?.state).toBe("unknown");
    expect(apply.roles.find((role) => role.role === "text")?.state).toBe("inactive");
    expect(apply.attention).toBeNull();

    await saveSettings({ discover: { windowDays: 10 } }, "admin");
    apply = await readSettingsApply();
    expect(apply.roles.find((role) => role.role === "crawler")?.state).toBe("waiting");
    expect(apply.attention).toBeNull();

    // 저장한 지 11분 — 저장이 쓰는 것과 같은 UTC 벽시계로 당긴다
    await db.update(crawlSettings).set({ updatedAt: sql`(now() at time zone 'utc') - interval '11 minutes'` }).where(eq(crawlSettings.id, 1));
    apply = await readSettingsApply();
    expect(apply.attention).toMatchObject({ key: "settings-apply", count: 1 });

    await workerTick("crawler");
    apply = await readSettingsApply();
    expect(apply.roles.find((role) => role.role === "crawler")?.state).toBe("applied");
    expect(apply.attention).toBeNull();
  });
});

describe("기본값 되돌리기와 수집 스위치", () => {
  it("되돌려도 수집 켜짐은 그대로다", async () => {
    await saveSettings({ enabled: true, reviewConcurrency: 4 }, "admin");
    expect((await resetSettings("admin")).ok).toBe(true);
    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.reviewConcurrency).toBe(2);
  });
});

/** 크롤 설정 화면이 보내는 폼 그대로 — 수집 스위치 칸은 없다 */
function settingsForm(version: string, over: Record<string, string> = {}): FormData {
  const d = DEFAULT_CRAWL_SETTINGS, form = new FormData();
  form.set("settingsVersion", version);
  form.set("queryCount", String(d.discover.queries.length));
  d.discover.queries.forEach((q, i) => {
    form.set(`query.${i}.label`, q.label); form.set(`query.${i}.kind`, q.kind); form.set(`query.${i}.query`, q.query);
    form.set(`query.${i}.priority`, String(q.priority)); form.set(`query.${i}.builder`, q.builder ?? "");
    if (q.enabled) form.set(`query.${i}.enabled`, "on");
  });
  for (const key of ["windowDays", "pagesPerTick"] as const) form.set(key, String(d.discover[key]));
  form.set("sort", d.discover.sort);
  for (const key of ["autoApproveMinStars", "minStars", "maxPushAgeDays"] as const) form.set(key, String(d.judge[key]));
  for (const key of ["blockedHomepageDomains", "thirdPartyHosts", "stubPageTitles", "excludedRepoPatterns", "heldRepoPatterns"] as const) {
    form.set(key, d.judge[key].join("\n"));
  }
  for (const key of ["excludeForks", "excludeOrganizations", "holdAmbiguous"] as const) if (d.judge[key]) form.set(key, "on");
  if (d.secondReview.enabled) form.set("secondReviewEnabled", "on");
  d.secondReview.voters.forEach((voter, i) => { form.set(`voterProvider${i}`, voter.provider); form.set(`voterModel${i}`, voter.model); });
  form.set("secondReviewSamplePercent", String(Math.round(d.secondReview.sampleRate * 100)));
  form.set("secondReviewAgreeAt", String(d.secondReview.agreeAt));
  form.set("reviewConcurrency", String(d.reviewConcurrency));
  for (const [key, value] of Object.entries(over)) form.set(key, value);
  return form;
}

describe("크롤 설정 폼 저장은 수집 켜짐·꺼짐을 바꾸지 않는다(ADM-18, C4)", () => {
  it.each([true, false])("저장된 수집 %s — 칸 없는 폼을 저장해도, 옛 폼이 enabled 를 보내도 그대로", async (enabled) => {
    await saveSettings({ enabled }, "operations-center");
    let result = await saveCrawlSettings(null, settingsForm(settingsFormVersion(await getSettings()), { windowDays: "9" }));
    expect(result).toMatchObject({ ok: true });
    expect((await getSettings()).enabled).toBe(enabled);
    expect((await getSettings()).discover.windowDays).toBe(9);

    result = await saveCrawlSettings(null, settingsForm(result!.version!, { enabled: enabled ? "" : "on", windowDays: "10" }));
    expect(result).toMatchObject({ ok: true });
    expect((await getSettings()).enabled).toBe(enabled);
  });
});

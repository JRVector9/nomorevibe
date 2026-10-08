import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsObservations } from "@/lib/db/schema";
import { getSettings, saveSettings, settingsFormVersion } from "@/lib/crawl/settings";
import { ATTENTION_HISTORY_KEY, attentionAcks, readAttentionHistory, recordAttentionSample } from "@/lib/operations/attention";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
const { acknowledgeAttention, setCollectionEnabled } = await import("@/app/admin/status/actions");

/**
 * 조치할 일의 기억(ADM-08)과 수집 스위치(ADM-18) — 새 표 없이 관측 표 한 줄과 작업 로그로 돈다.
 * 작업 로그는 지울 수 없어(0056) 다른 테스트가 남긴 숨김이 있을 수 있다 — 이 파일만 쓰는 열쇠를 고른다.
 */
beforeAll(ensureSchema);
let floor = 0;
beforeEach(async () => {
  mocks.admin.mockResolvedValue({ login: "operator" });
  await db.delete(operationsObservations).where(eq(operationsObservations.key, ATTENTION_HISTORY_KEY));
  await db.delete(crawlSettings);
  await saveSettings({ enabled: true }, "test");
  floor = await auditFloor();
});

it("시간별 수는 55분에 한 번만 덧붙이고 25시간이 지난 것은 버린다", async () => {
  const at = (hours: number) => new Date(Date.UTC(2026, 9, 8, 0) + hours * 3_600_000);
  expect(await recordAttentionSample({ review: 10 }, at(0))).toBe(true);
  expect(await recordAttentionSample({ review: 11 }, at(0.5))).toBe(false);
  expect(await recordAttentionSample({ review: 12 }, at(1))).toBe(true);
  expect(await recordAttentionSample({ review: 13 }, at(25.5))).toBe(true);
  const [row] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, ATTENTION_HISTORY_KEY));
  expect(readAttentionHistory(row.value).map((sample) => sample.counts.review)).toEqual([12, 13]);
});

it("웹 두 대가 같은 때 적어도 한 줄만 남는다", async () => {
  const now = new Date();
  const results = await Promise.all(Array.from({ length: 4 }, () => recordAttentionSample({ review: 1 }, now)));
  expect(results.filter(Boolean)).toHaveLength(1);
});

it("확인함은 작업 로그에 남고 7일 숨기며, 다시 보이기가 더 최근이면 풀린다", async () => {
  expect(await acknowledgeAttention({ key: "evidence-backlog", hide: true, count: 39_749 })).toMatchObject({ message: expect.any(String) });
  const acks = await attentionAcks();
  expect(acks.get("evidence-backlog")).toMatchObject({ actor: "operator" });
  const ack = acks.get("evidence-backlog")!;
  expect(ack.until.getTime() - ack.at.getTime()).toBe(7 * 86_400_000);
  expect(await auditRowsAfter(floor, "attention-ack")).toMatchObject([{ actor: "operator", target: "evidence-backlog", detail: { count: 39_749, days: 7 } }]);

  await acknowledgeAttention({ key: "evidence-backlog", hide: false, count: 39_749 });
  expect((await attentionAcks()).has("evidence-backlog")).toBe(false);
  expect(await auditRowsAfter(floor, "attention-unack")).toHaveLength(1);
});

it("쌓인 일이 아닌 것은 숨기지 못하고, 로그인하지 않으면 아무것도 남기지 않는다", async () => {
  expect(await acknowledgeAttention({ key: "down", hide: true, count: 3 })).toHaveProperty("error");
  mocks.admin.mockResolvedValue(null);
  expect(await acknowledgeAttention({ key: "review", hide: true, count: 3 })).toHaveProperty("error");
  expect(await auditRowsAfter(floor)).toHaveLength(0);
});

it("수집 스위치는 enabled 하나만 바꾸고 사유를 작업 로그에 남긴다 — 열려 있던 설정 폼은 판이 바뀌어 거절된다", async () => {
  await saveSettings({ discover: { windowDays: 77 } }, "test");
  const before = await getSettings();
  expect(before.discover.windowDays).toBe(77);
  const formVersion = settingsFormVersion(before);
  floor = await auditFloor();

  expect(await setCollectionEnabled({ enabled: false, reason: "incident", note: "GitHub 장애" })).toMatchObject({ message: expect.stringContaining("껐습니다") });
  const after = await getSettings();
  expect(after.enabled).toBe(false);
  expect({ ...after, enabled: true }).toEqual(before);
  expect(await auditRowsAfter(floor, "collection-enabled")).toMatchObject([{ actor: "operator", ok: true,
    detail: { before: true, after: false, reason: "incident", note: "GitHub 장애" } }]);
  expect(await auditRowsAfter(floor, "settings-save")).toHaveLength(1);

  // 옛 폼이 꺼 둔 수집을 되살리지 않는다
  expect(await saveSettings({ ...before }, "form", { expectedFormVersion: formVersion })).toMatchObject({ ok: false });
  expect((await getSettings()).enabled).toBe(false);
});

it("수집 스위치는 사유가 없거나 목록 밖이면 바꾸지 않고, 이미 그 상태면 쓰지 않는다", async () => {
  expect(await setCollectionEnabled({ enabled: false, reason: "" })).toHaveProperty("error");
  expect(await setCollectionEnabled({ enabled: false, reason: "resolved" })).toHaveProperty("error");
  expect(await setCollectionEnabled({ enabled: false, reason: "other" })).toHaveProperty("error");
  expect(await setCollectionEnabled({ enabled: true, reason: "resolved" })).toMatchObject({ message: "이미 켜져 있습니다." });
  expect((await getSettings()).enabled).toBe(true);
  expect(await auditRowsAfter(floor)).toHaveLength(0);
});

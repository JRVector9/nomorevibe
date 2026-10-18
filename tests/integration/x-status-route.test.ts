import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { POST } from "@/app/api/ops/x-status/route";
import { signXStatus, X_STATUS_KEY, X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";
import { ensureSchema } from "./setup";

/*
 * 운영센터 v8 PR9: X 수집기 하루 보고를 실제 PostgreSQL 로 받는다.
 * 관측 표의 x-status 한 줄만 만들고 지운다. 받은 시각은 DB 시계(UTC 벽시계)이고, 단조·60초 속도 제한은 조건부 upsert 가 지킨다.
 */
const SECRET = "x-status-current-secret-0123456789abcdef", OLD = "x-status-previous-secret-0123456789abcdef";
const body = (patch: Record<string, unknown> = {}) => ({ v: 1, mode: "live", reads: { used: 10, limit: 10 }, candidates: 2,
  lastRunAt: new Date(Date.now() - 60_000).toISOString(), lastSuccessAt: null, error: null, ...patch });
function signed(value: unknown, timestamp: number, secret = SECRET) {
  const raw = JSON.stringify(value);
  return new Request("https://nomorevibe.test/api/ops/x-status", { method: "POST", body: raw, headers: {
    "content-type": "application/json", "x-nmv-timestamp": String(timestamp), "x-nmv-signature": signXStatus(secret, timestamp, raw) } });
}
const stored = async () => (await db.select({ value: operationsObservations.value,
  ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${operationsObservations.observedAt}))::float8` })
  .from(operationsObservations).where(eq(operationsObservations.key, X_STATUS_KEY)))[0];
const now = () => Math.floor(Date.now() / 1000);

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(operationsObservations).where(eq(operationsObservations.key, X_STATUS_KEY));
  clearAllMemos();
  vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
  vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, OLD);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(operationsObservations).where(eq(operationsObservations.key, X_STATUS_KEY));
});

it("꺼진 주소는 404 이고 줄을 만들지 않는다", async () => {
  vi.stubEnv(X_STATUS_SECRET_ENV, "");
  expect((await POST(signed(body(), now()))).status).toBe(404);
  expect(await stored()).toBeUndefined();
});

it("서명한 보고 하나를 한 줄로 받는다 — 받은 시각은 DB 시계, 같은 보고를 다시 보내면 409 이고 줄은 그대로다", async () => {
  const sentAt = now(), request = signed(body(), sentAt);
  expect((await POST(request)).status).toBe(200);
  const first = await stored();
  expect(first.value).toEqual({ ...body(), lastRunAt: expect.any(String), sentAt, signedWith: "current" });
  expect(Math.abs(first.ageSeconds)).toBeLessThan(5);
  const replay = await POST(signed(body(), sentAt));
  expect([replay.status, await replay.json()]).toEqual([409, { error: "x_status_not_newer" }]);
  expect((await stored()).value).toEqual(first.value);
});

it("새 보고라도 마지막으로 받은 지 60초 안이면 429, 지나면 받는다 — 옛 보고는 409", async () => {
  const sentAt = now() - 10;
  expect((await POST(signed(body(), sentAt))).status).toBe(200);
  const limited = await POST(signed(body({ candidates: 5 }), sentAt + 1));
  expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  expect((await stored()).value).toMatchObject({ candidates: 2 });
  await db.update(operationsObservations).set({ observedAt: sql`(now() at time zone 'utc') - interval '61 seconds'` })
    .where(eq(operationsObservations.key, X_STATUS_KEY));
  expect((await POST(signed(body({ candidates: 5 }), sentAt - 1))).status).toBe(409);
  expect((await POST(signed(body({ candidates: 5 }), sentAt + 2, OLD))).status).toBe(200);
  expect((await stored()).value).toMatchObject({ candidates: 5, sentAt: sentAt + 2, signedWith: "previous" });
});

it("이미 있는 줄의 sentAt 이 깨져 있어도 다음 보고가 덮어쓴다", async () => {
  await db.insert(operationsObservations).values({ key: X_STATUS_KEY, value: { sentAt: "broken" },
    observedAt: sql`(now() at time zone 'utc') - interval '2 minutes'` });
  expect((await POST(signed(body(), now()))).status).toBe(200);
  expect((await stored()).value).toMatchObject({ mode: "live", signedWith: "current" });
});

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { emailOutbox } from "@/lib/db/me-schema";
import { emailLoginChallenges } from "@/lib/db/public-user-schema";
import { emailHealth, emailOutboxLevel, loginEmailLevel } from "@/lib/operations/email-health";
import { ensureSchema } from "./setup";

/*
 * 메일이 정말 나가고 있나(lib/operations/email-health.ts) 실제 PostgreSQL — 수만 센다(주소·본문을 읽지 않는다).
 * 발송함은 이틀 창(하루 지난 줄은 만든 지 24~48시간에 닫힌다), 로그인 코드는 만료 색인(만든 뒤 10분)으로 최근 24시간을 고른다.
 * 이 파일은 두 표를 비우고 쓴다.
 */
const hex = "a".repeat(64);
const hoursAgo = (hours: number) => sql`now() - ${hours} * interval '1 hour'`;
const outbox = (state: string, createdHoursAgo: number, lastError: string | null = null) => db.insert(emailOutbox).values({
  kind: "followed_release", dedupeKey: `test:${randomUUID()}`, state: state as never, lastError, createdAt: hoursAgo(createdHoursAgo) as never,
  attempts: state === "pending" ? 1 : 2 });
const challenge = (deliveryState: string, createdHoursAgo: number) => db.insert(emailLoginChallenges).values({
  id: randomUUID(), email: `t${randomUUID().slice(0, 8)}@example.test`, codeHash: hex, browserNonceHash: hex, deliveryState: deliveryState as never,
  createdAt: hoursAgo(createdHoursAgo) as never, expiresAt: sql`now() - ${createdHoursAgo} * interval '1 hour' + interval '10 minutes'` as never });

beforeAll(() => ensureSchema());
const clear = async () => { await db.delete(emailOutbox); await db.delete(emailLoginChallenges); };
beforeEach(clear);
afterEach(clear);

it("빈 표 — 모두 0 이고 경보가 없다", async () => {
  const health = await emailHealth();
  expect(health).toEqual({ outbox: { pending: 0, pendingOverdue: 0, oldestPendingMinutes: null, accepted: 0, unknown: 0, rejected: 0, expired: 0 },
    login: { total24h: 0, failed24h: 0, recent: [] } });
  expect([emailOutboxLevel(health.outbox), loginEmailLevel(health.login)]).toEqual([null, null]);
});

it("발송함 — 대기·1시간 넘은 대기·가장 오래된 나이, 이틀 안에 보냄·모름·거절·하루 지나 닫음을 센다(그보다 오래된 줄은 빼고)", async () => {
  await outbox("pending", 0.1);
  await outbox("pending", 2.5);
  await outbox("accepted", 3);
  await outbox("unknown", 30, "expired");
  await outbox("rejected", 5, "rejected");
  await outbox("skipped", 30, "expired");
  await outbox("skipped", 2, "recipient_or_setting_off");
  await outbox("unknown", 72, "expired");
  const { outbox: health } = await emailHealth();
  expect(health).toEqual({ pending: 2, pendingOverdue: 1, oldestPendingMinutes: 150, accepted: 1, unknown: 1, rejected: 1, expired: 1 });
  expect(emailOutboxLevel(health)).toBe("hold");
});

it("로그인 코드 — 최근 24시간 전체·실패와 결과가 정해진 가장 최근 세 통(새것부터), 셋 다 실패면 긴급", async () => {
  await challenge("accepted", 20);
  await challenge("rejected", 3);
  await challenge("pending", 0.01);
  await challenge("unknown", 2);
  await challenge("rejected", 1);
  await challenge("rejected", 30);
  const { login } = await emailHealth();
  expect(login).toEqual({ total24h: 5, failed24h: 3, recent: ["rejected", "unknown", "rejected"] });
  expect(loginEmailLevel(login)).toBe("critical");
});

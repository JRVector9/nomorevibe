import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { jobs, operationsObservations } from "@/lib/db/schema";
import { jobDeferralKey, readJobDeferrals, readLastJobDeferrals, recordJobDeferral, writeJobDeferral } from "@/lib/jobs/deferral-observation";
import { runJob } from "@/lib/jobs/runner";
import { operationsData } from "@/lib/operations/admin";
import { ensureSchema } from "./setup";

// 미룬 이유 관측 defer:<job>(v8 PR4) 실제 PostgreSQL: 분 묶음 합치기·60분 밖 버림·DB 시계, 복제본 자리 읽기, 기존 전체 읽기 제외.
// 이 파일이 만든 잡 이름(pr4-defer-*)의 jobs·관측 행만 쓰고 지운다. DR fence 는 건드리지 않는다(fenced 무쓰기는 단위 테스트가 본다).
const tag = randomUUID().slice(0, 8);
const names = { merge: `pr4-defer-${tag}-merge`, read: `pr4-defer-${tag}-read`, runner: `pr4-defer-${tag}-runner`, admin: `pr4-defer-${tag}-admin` };
const keys = Object.values(names).map(jobDeferralKey);
const minuteKey = (offset: string) => sql`to_char(date_trunc('minute', clock_timestamp() AT TIME ZONE 'UTC') - ${offset}::interval, 'YYYY-MM-DD"T"HH24:MI"Z"')`;
const counts = async (key: string) => {
  const [row] = await db.select({ value: operationsObservations.value, ageSeconds: sql<number>`extract(epoch from ((clock_timestamp() AT TIME ZONE 'UTC') - ${operationsObservations.observedAt}))::float8` })
    .from(operationsObservations).where(inArray(operationsObservations.key, [key]));
  return row;
};

beforeAll(() => ensureSchema());
afterEach(async () => {
  await db.delete(operationsObservations).where(inArray(operationsObservations.key, keys));
  await db.delete(jobs).where(inArray(jobs.name, Object.values(names)));
});

it("merges per-minute counts on the DB clock, keeps the latest reason and drops buckets older than 60 minutes", async () => {
  const key = jobDeferralKey(names.merge);
  await db.execute(sql`INSERT INTO operations_observations (key, value, observed_at) VALUES (${key}, jsonb_build_object(
    'reason', 'model_capacity', 'at', '2026-10-18T00:00:00.000Z', 'counts', jsonb_build_object(
      ${minuteKey("3 hours")} || '|model_capacity', 50, ${minuteKey("5 minutes")} || '|model_capacity', 4, 'garbage', 9)),
    clock_timestamp() AT TIME ZONE 'UTC' - interval '3 hours')`);
  await writeJobDeferral({ key, reason: "model_capacity", counts: { model_capacity: 2 } });
  await writeJobDeferral({ key, reason: "stage_blocked", counts: { stage_blocked: 1, model_capacity: 1 } });
  const row = await counts(key);
  expect(row.value).toMatchObject({ reason: "stage_blocked", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
  expect(row.ageSeconds).toBeLessThan(60);
  const buckets = Object.entries(row.value.counts as Record<string, number>);
  // 3시간 전 묶음과 모양이 틀린 키는 사라지고, 5분 전 묶음과 이번 두 번의 쓰기(분이 넘어가도 이유별 합은 같다)가 남는다
  expect(buckets.every(([bucket]) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\|[a-z_]+$/.test(bucket))).toBe(true);
  const total = (reason: string) => buckets.filter(([bucket]) => bucket.endsWith(`|${reason}`)).reduce((sum, [, count]) => sum + count, 0);
  expect({ model_capacity: total("model_capacity"), stage_blocked: total("stage_blocked") }).toEqual({ model_capacity: 7, stage_blocked: 1 });
  expect(buckets.length).toBeLessThanOrEqual(4);
});

it("reads reason, last-hour count and the DB time through the injected replica-only scope", async () => {
  const key = jobDeferralKey(names.read);
  await writeJobDeferral({ key, reason: "http_origin_permit", counts: { http_origin_permit: 3 } });
  const [{ now }] = await db.execute<{ now: string }>(sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::text AS now`);
  const read = await readJobDeferrals(load => load());
  expect(read.state).toBe("ready");
  if (read.state !== "ready") return;
  expect(Math.abs(Date.parse(read.at) - Date.parse(`${now.replace(" ", "T")}Z`))).toBeLessThan(10_000);
  expect(read.jobs.find(job => job.job === names.read)).toEqual({ job: names.read, reason: "http_origin_permit",
    lastDeferredAt: expect.any(String), lastHour: 3, lastHourByReason: { http_origin_permit: 3 } });
  expect(await readJobDeferrals(async () => null)).toEqual({ state: "held", reason: "replica_unavailable" });
});

it("records a real runner deferral without touching job:<name>, and the throttle keeps repeats in memory", async () => {
  const onDeferred = (reason: string) => recordJobDeferral(names.runner, reason);
  for (let i = 0; i < 3; i++) {
    expect(await runJob(names.runner, async () => ({ done: false, deferred: "stage_blocked" }), { onDeferred }))
      .toMatchObject({ status: "deferred", reason: "stage_blocked" });
  }
  const row = await counts(jobDeferralKey(names.runner));
  expect(row.value).toMatchObject({ reason: "stage_blocked" });
  // 첫 미룸만 바로 쓰고 같은 이유의 다음 둘은 1분 안이라 다음 쓰기를 기다린다
  expect(Object.values(row.value.counts as Record<string, number>)).toEqual([1]);
  expect(await db.select().from(operationsObservations).where(inArray(operationsObservations.key, [`job:${names.runner}`]))).toEqual([]);
});

it("keeps the existing primary reads (admin operationsData) as they were — defer:* rows are not read there", async () => {
  await writeJobDeferral({ key: jobDeferralKey(names.admin), reason: "source_buffer", counts: { source_buffer: 1 } });
  const data = await operationsData();
  expect(data.observations.some(row => row.key.startsWith("defer:"))).toBe(false);
});

it("성공 끊김 판정용 — 물은 잡의 마지막 미룸 까닭만 열쇠로 읽고, 묻지 않으면 읽지 않는다", async () => {
  await writeJobDeferral({ key: jobDeferralKey(names.read), reason: "stage_blocked", counts: { stage_blocked: 1 } });
  await writeJobDeferral({ key: jobDeferralKey(names.merge), reason: "model_capacity", counts: { model_capacity: 1 } });
  const read = await readLastJobDeferrals([names.read, names.admin]);
  expect([...read.keys()]).toEqual([names.read]);
  expect(read.get(names.read)).toEqual({ reason: "stage_blocked", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
  expect((await readLastJobDeferrals([])).size).toBe(0);
});

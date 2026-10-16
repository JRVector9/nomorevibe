import { afterAll, beforeAll, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "@/lib/db/schema";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { collectLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live-repository";
import { LIVE_OPTIONAL_TABLES, reportLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live";
import { TEST_DATABASE_URL } from "./setup";

/** 운영 DB와 같은 0000–0076 스키마를 별도 로컬 DB에 만든다(저장소 drizzle 폴더는 읽기만 한다). */
const DATABASE = "nomorevibe_live0076_test";
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${DATABASE}`;
const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
const folder = mkdtempSync(join(tmpdir(), "nomorevibe-drizzle-0076-"));
let applied = 0;
beforeAll(async () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, journal.entries.findIndex(row => row.tag.startsWith("0076_")) + 1);
  expect(entries.at(-1)?.tag.startsWith("0076_")).toBe(true);
  mkdirSync(join(folder, "meta"));
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const row of entries) copyFileSync(join("drizzle", `${row.tag}.sql`), join(folder, `${row.tag}.sql`));
  applied = entries.length;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
  await client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(client), { migrationsFolder: folder });
});
afterAll(async () => {
  await client.end({ timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin.end({ timeout: 5 });
  rmSync(folder, { recursive: true, force: true });
});

it("collects on the 0076 production schema with absent stage/lease/capacity tables fixed as legacy", async () => {
  const [absent] = await client.unsafe(`select ${LIVE_OPTIONAL_TABLES.map(name => `to_regclass('public.${name}') is null as ${name}`).join(", ")}`);
  expect(Object.values(absent)).toEqual([true, true, true]);
  const values = { enabled: true, reviewMode: "enforce", firstReview: { provider: "abcllm", model: "first" },
    secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "second" }], fallbacks: [], sampleRate: 0 } };
  const settings = mergeWithDefaults(values), policy = reviewPolicyHash(settings), hash = "c".repeat(64);
  // 시각은 모두 DB의 UTC 벽시계로 만든다(운영 열과 같은 timestamp without time zone).
  const ago = (minutes: number) => `(now() at time zone 'utc') - interval '${minutes} minutes'`;
  const iso = (minutes: number) => `to_char(${ago(minutes)}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  await client.unsafe(`insert into crawl_settings (id, values, updated_at) values (1, $1::jsonb, ${ago(120)})`, [JSON.stringify(values)]);
  // 구간 시작 전부터 준비 대기였던 후보(증인)와, 구간 안에서 AI1 승인+필수 AI2 승인으로 끝난 후보.
  await client.unsafe(`insert into crawl_documents (repo, repo_meta, fetched_at) values ('live/waiting', '{}', ${ago(120)}), ('live/app', '{}', ${ago(15)})`);
  const [waiting] = await client.unsafe(`insert into crawl_candidates (repo, state, decided_by, updated_at, judged_at)
    values ('live/waiting', 'approved', 'auto', ${ago(120)}, ${ago(120)}) returning id`);
  const [done] = await client.unsafe(`insert into crawl_candidates (repo, state, decided_by, updated_at) values ('live/app', 'approved', 'auto', ${ago(8)}) returning id`);
  const [attempt] = await client.unsafe(`insert into crawl_review_attempts (candidate_id, kind, state, input_hash, policy_hash, source_revision_hash,
      snapshot, source, prompt_version, rules_version, provider, model, attempt_number, outcome, started_at, completed_at, valid_until)
    values ($1, 'automatic', 'succeeded', $2, $3, $2, '{}',
      jsonb_build_object('documentFetchedAt', ${iso(15)}, 'candidateJudgedAt', ${iso(14)}), $4, $5,
      'abcllm', 'first', 1, '{"decision":"approve"}', ${ago(10)}, ${ago(9)}, (now() at time zone 'utc') + interval '1 day')
    returning id`, [done.id, hash, policy, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION]);
  await client.unsafe(`update crawl_candidates set signals = jsonb_build_object('agentReviewAttemptId', $1::int) where id = $2`, [attempt.id, done.id]);
  await client.unsafe(`insert into second_reviews (candidate_id, repo, trigger, first_decision, first_model, first_attempt_id, input_hash,
      provider, model, second_decision, status, created_at, reviewed_at)
    values ($1, 'live/app', 'ai_approved', 'approve', 'first', $2, $3, 'abcllm', 'second', 'approve', 'agreed', ${ago(9)}, ${ago(8)})`,
  [done.id, attempt.id, hash]);
  const [now] = await client.unsafe(`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`);
  const end = Date.parse(now.now as string);
  const artifact = await collectLiveCapacityWindow(drizzle(client, { schema }), { runId: "live-0076", revision: "9e13341", target: "primary",
    startedAt: new Date(end - 40 * 60_000).toISOString(), endedAt: new Date(end).toISOString() });
  expect(artifact.schema).toEqual({ appliedMigrations: applied, absentTables: [...LIVE_OPTIONAL_TABLES] });
  expect(artifact.stageModes).toEqual(["ai1", "ai2", "fetch"].map(stage => ({ stage, mode: "legacy", epoch: 1, changedSinceStart: false })));
  expect(artifact.modelCapacity).toEqual({ mode: "disabled", changedSinceStart: false });
  expect(artifact.readiness).toEqual({ witnesses: 1, sampleCandidateIds: [waiting.id] });
  const report = reportLiveCapacityWindow(artifact);
  expect(report.evidenceIssues).toEqual([]);
  expect(report.finals).toMatchObject({ newCandidates: 1, approvals: 1 });
  // 준비(14분 전 판정)→최종(8분 전 AI2 승인) 경과를 SQL이 잰다. 문장별 now() 차이만 허용한다.
  expect(Math.abs(report.latencyMs.endToEnd.p95! - 6 * 60_000)).toBeLessThan(5_000);
  expect(artifact.ai2Calls).toEqual({ chains: 1, calls: 1, failed: 0, unattributedChains: 0 });
});

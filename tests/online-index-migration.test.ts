import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentRepositoryScans, modelCapacityRequests, pipelineItemLeases, secondReviews } from "@/lib/db/schema";
import { concurrentStatement, parseIndexStatements, parseOnlineIndexOptions } from "../scripts/ops/online-index";

// 0192 의 모양을 고정한다(실제 동작은 tests/integration/online-index-tool.test.ts · online-index-plans.test.ts 가 본다).
// 인덱스 정의는 마이그레이션의 CREATE INDEX IF NOT EXISTS 문이 원천이고, 운영 도구(scripts/ops/online-index.ts)가 그 문장을 읽는다.
const TAG = "0192_online_missing_indexes";
const raw = readFileSync(`drizzle/${TAG}.sql`, "utf8");
const chunks = raw.split("--> statement-breakpoint").map((chunk) => chunk.replace(/^\s*--.*$/gm, "").trim());
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const TARGETS = [
  ["second_reviews", "second_reviews_first_attempt_idx"],
  ["second_reviews", "second_reviews_fallback_for_idx"],
  ["model_capacity_requests", "model_capacity_requests_logical_key_idx"],
  ["pipeline_item_leases", "pipeline_item_leases_ai2_candidate_idx"],
  ["agent_repository_scans", "agent_scans_repository_latest_idx"],
] as const;
const guardTargets = (chunk: string) => [...chunk.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((match) => [match[1], match[2]]);

describe("0192 migration text", () => {
  it("is registered after 0191 and waits for locks at most five seconds", () => {
    const position = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(journal.entries[position]).toMatchObject({ idx: 192, when: 1795219200001 });
    expect(journal.entries[position - 1]).toMatchObject({ idx: 191, tag: "0191_repository_identity_anchors", when: 1795219200000 });
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("stops before building when a large table still lacks its index, and names the tool", () => {
    const guard = chunks[1];
    expect(guardTargets(guard)).toEqual(TARGETS);
    expect(guard).toContain("WHERE to_regclass(v.idx) IS NULL");
    expect(guard).toContain("c.reltuples >= 50000 OR pg_relation_size(c.oid) >= 33554432");
    expect(guard).toMatch(/RAISE EXCEPTION '0192 stopped: large table without its index[^']*scripts\/ops\/online-index\.ts/);
  });

  it("creates each index only when its name is absent, so an online-built index takes no table lock", () => {
    const statements = parseIndexStatements(raw);
    expect(statements.map((statement) => [statement.table, statement.index])).toEqual(TARGETS);
    expect(statements.map((statement) => statement.statement)).toEqual([
      `CREATE INDEX IF NOT EXISTS "second_reviews_first_attempt_idx" ON "second_reviews" ("first_attempt_id") WHERE "first_attempt_id" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "second_reviews_fallback_for_idx" ON "second_reviews" ("fallback_for_id") WHERE "fallback_for_id" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "model_capacity_requests_logical_key_idx" ON "model_capacity_requests" ("logical_work_key") WHERE "logical_work_key" IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS "pipeline_item_leases_ai2_candidate_idx" ON "pipeline_item_leases" (("binding"->>'candidateId')) WHERE "stage" = 'ai2'`,
      `CREATE INDEX IF NOT EXISTS "agent_scans_repository_latest_idx" ON "agent_repository_scans" ("repository_key", "scope", "started_at" DESC, "id" DESC)`,
    ]);
    // 모든 인덱스 문이 「이름이 없을 때만」 안에 있다 — IF NOT EXISTS 만으로는 표의 SHARE 잠금을 먼저 잡는다
    const body = chunks[2].replace(/\s+/g, " ");
    for (const statement of statements)
      expect(body).toContain(`IF to_regclass('${statement.index}') IS NULL THEN ${statement.statement}; END IF;`);
    expect(raw.match(/CREATE\s+(UNIQUE\s+)?INDEX/g)).toHaveLength(TARGETS.length);
  });

  it("ends by requiring every index valid on its own table", () => {
    const guard = chunks[3];
    expect(guardTargets(guard)).toEqual(TARGETS);
    expect(guard).toContain("i.indexrelid = to_regclass(v.idx) AND i.indrelid = to_regclass(v.tbl)");
    expect(guard).toContain("i.indisvalid AND i.indisready AND i.indislive");
    expect(guard).toMatch(/RAISE EXCEPTION '0192 stopped: index missing or INVALID/);
  });

  it("never builds concurrently or drops anything inside the migration transaction", () => {
    const sql = chunks.join("\n");
    expect(sql).not.toMatch(/CONCURRENTLY|DROP |ALTER |TRUNCATE|DELETE |UPDATE |INSERT /);
  });
});

describe("0192 schema declarations", () => {
  const declared = (table: Parameters<typeof getTableConfig>[0], name: string) => getTableConfig(table).indexes.find((index) => index.config.name === name)?.config;

  it("declares the five indexes on the same tables, none unique", () => {
    const tables = { second_reviews: secondReviews, model_capacity_requests: modelCapacityRequests,
      pipeline_item_leases: pipelineItemLeases, agent_repository_scans: agentRepositoryScans };
    for (const [table, index] of TARGETS) expect(declared(tables[table], index), index).toMatchObject({ unique: false });
    expect(parseIndexStatements(raw).every((statement) => !statement.unique)).toBe(true);
  });

  it("keeps partial predicates where the migration has them", () => {
    const statements = parseIndexStatements(raw);
    expect(statements.map((statement) => statement.predicate)).toEqual([`"first_attempt_id" IS NOT NULL`, `"fallback_for_id" IS NOT NULL`,
      `"logical_work_key" IS NOT NULL`, `"stage" = 'ai2'`, null]);
    expect(statements.map((statement) => statement.keys)).toEqual([[`"first_attempt_id"`], [`"fallback_for_id"`], [`"logical_work_key"`],
      [`("binding"->>'candidateId')`], [`"repository_key"`, `"scope"`, `"started_at"`, `"id"`]]);
    for (const name of ["second_reviews_first_attempt_idx", "second_reviews_fallback_for_idx"]) expect(declared(secondReviews, name)?.where).toBeDefined();
    expect(declared(modelCapacityRequests, "model_capacity_requests_logical_key_idx")?.where).toBeDefined();
    expect(declared(pipelineItemLeases, "pipeline_item_leases_ai2_candidate_idx")?.where).toBeDefined();
    expect(declared(agentRepositoryScans, "agent_scans_repository_latest_idx")?.where).toBeUndefined();
    expect(declared(agentRepositoryScans, "agent_scans_repository_latest_idx")?.columns).toHaveLength(4);
  });
});

describe("online index tool — reading a migration file", () => {
  it("inserts CONCURRENTLY and nothing else", () => {
    const [first] = parseIndexStatements(raw);
    expect(concurrentStatement(first)).toBe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "second_reviews_first_attempt_idx" ON "second_reviews" ("first_attempt_id") WHERE "first_attempt_id" IS NOT NULL`);
    const [unique] = parseIndexStatements("CREATE UNIQUE INDEX IF NOT EXISTS a_idx ON a USING btree (x, lower(y)) WHERE z = 'where' OR x > 0;");
    expect(unique).toMatchObject({ index: "a_idx", table: "a", unique: true, predicate: "z = 'where' OR x > 0", keys: ["x", "lower(y)"] });
    expect(concurrentStatement(unique)).toBe("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a USING btree (x, lower(y)) WHERE z = 'where' OR x > 0");
  });

  it("ignores commented statements and refuses any CREATE INDEX it cannot run online as written", () => {
    expect(parseIndexStatements("-- CREATE INDEX IF NOT EXISTS gone_idx ON t (a);\nCREATE INDEX IF NOT EXISTS kept_idx ON t (a);").map((item) => item.index)).toEqual(["kept_idx"]);
    for (const unsupported of [
      "CREATE INDEX plain_idx ON t (a);",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS already_idx ON t (a);",
      "CREATE INDEX IF NOT EXISTS qualified_idx ON public.t (a);",
      "CREATE INDEX IF NOT EXISTS one_idx ON t (a);\nCREATE INDEX IF NOT EXISTS one_idx ON t (b);",
    ]) expect(() => parseIndexStatements(unsupported), unsupported).toThrow(/^online_index_/);
    expect(parseIndexStatements("SELECT 1;")).toEqual([]);
  });

  it("defaults to plan mode and takes the file as its only positional argument", () => {
    expect(parseOnlineIndexOptions(["drizzle/x.sql"])).toEqual({ file: "drizzle/x.sql", execute: false, only: null,
      lockTimeoutMs: 3000, lockRetries: 5, waitTimeoutMs: 1_800_000, progressMs: 5000 });
    expect(parseOnlineIndexOptions(["drizzle/x.sql", "--execute", "--only", "a_idx", "--lock-timeout-ms", "1500", "--lock-retries", "2",
      "--wait-timeout-ms", "0", "--progress-ms", "1000"])).toEqual({ file: "drizzle/x.sql", execute: true, only: "a_idx",
      lockTimeoutMs: 1500, lockRetries: 2, waitTimeoutMs: 0, progressMs: 1000 });
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { repositoryIdentityAnchors } from "@/lib/db/repository-identity-schema";

// 0191 의 모양을 고정한다(실제 동작은 tests/integration/repository-identity-anchors.test.ts 가 본다).
// 주석은 떼고 본다 — 주석에 적은 낱말(SECURITY DEFINER 등)에 걸리지 않게.
const migration = readFileSync("drizzle/0191_repository_identity_anchors.sql", "utf8").replace(/--(?!> statement-breakpoint).*$/gm, "");
const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim());
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };

describe("0191 migration text", () => {
  it("is registered in the journal and waits for locks at most five seconds", () => {
    const entry = journal.entries.find((item) => item.tag === "0191_repository_identity_anchors");
    expect(entry).toMatchObject({ idx: 191, when: 1795219200000 });
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("rejects delete and truncate on the anchor table even while replication applies changes", () => {
    expect(migration).toContain("CREATE TRIGGER repository_identity_anchors_no_change BEFORE UPDATE OR DELETE ON repository_identity_anchors");
    expect(migration).toContain("CREATE TRIGGER repository_identity_anchors_no_truncate BEFORE TRUNCATE ON repository_identity_anchors");
    for (const name of ["repository_identity_anchors_no_change", "repository_identity_anchors_no_truncate"])
      expect(migration).toContain(`ALTER TABLE repository_identity_anchors ENABLE ALWAYS TRIGGER ${name};`);
  });

  it("records from the three sources on insert, change and delete, and creates those triggers last", () => {
    const triggers = statements.map((statement, index) => ({ index, match: /^CREATE TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE)[^\n]* ON (\w+)/.exec(statement) }))
      .filter((item) => item.match);
    expect(triggers.map((item) => `${item.match![3]} ${item.match![2]}`)).toEqual([
      "crawl_documents INSERT", "crawl_documents UPDATE", "crawl_documents DELETE",
      "product_evidence_sources INSERT", "product_evidence_sources UPDATE", "product_evidence_sources DELETE",
      "product_star_observations INSERT", "product_star_observations UPDATE", "product_star_observations DELETE",
    ]);
    // 세 표의 SHARE ROW EXCLUSIVE 를 잡은 뒤에는 다른 문장이 없다
    expect(triggers.map((item) => item.index)).toEqual(Array.from({ length: 9 }, (_, offset) => statements.length - 9 + offset));
    // id 가 그대로인 갱신은 함수를 부르지 않는다
    expect(statements.find((statement) => statement.startsWith("CREATE TRIGGER crawl_documents_identity_anchor_update")))
      .toMatch(/AFTER UPDATE OF repo_meta, repo ON crawl_documents\s+FOR EACH ROW WHEN \(OLD\.repo IS DISTINCT FROM NEW\.repo\s+OR \(OLD\.repo_meta->>'id'\) IS DISTINCT FROM \(NEW\.repo_meta->>'id'\)/);
    expect(statements.find((statement) => statement.startsWith("CREATE TRIGGER product_evidence_sources_identity_anchor_update")))
      .toMatch(/\(OLD\.normalized_facts->>'repositoryId'\) IS DISTINCT FROM \(NEW\.normalized_facts->>'repositoryId'\)/);
  });

  it("adds no definer function, no grant, no row security and never swallows a failed anchor write", () => {
    // 재생 handler profile 은 SECURITY DEFINER 트리거를 거절하고, Oracle 계정 권한은 deploy/oracle 에서만 준다
    expect(migration).not.toMatch(/SECURITY DEFINER|GRANT |REVOKE |ROW LEVEL SECURITY|CREATE POLICY|EXCEPTION\s+WHEN/);
    expect(migration).not.toMatch(/DROP |ALTER TABLE (?!repository_identity_anchors ENABLE ALWAYS TRIGGER)/);
  });
});

describe("repository_identity_anchors schema", () => {
  it("matches the migration: one row per (repo_key, kind, value) and the same checks", () => {
    const config = getTableConfig(repositoryIdentityAnchors);
    expect(config.columns.map((column) => column.name)).toEqual(["repo_key", "kind", "value", "source", "first_seen_at", "last_seen_at"]);
    expect(config.primaryKeys.map((key) => [key.getName(), key.columns.map((column) => column.name)]))
      .toEqual([["repository_identity_anchors_pkey", ["repo_key", "kind", "value"]]]);
    expect(migration).toContain("CONSTRAINT repository_identity_anchors_pkey PRIMARY KEY (repo_key, kind, value)");
    for (const check of config.checks) expect(migration).toContain(`CONSTRAINT ${check.name} CHECK`);
    expect(config.checks).toHaveLength(5);
    // NULL 을 통과시키지 않는 비교여야 한다(검증 함수는 모양이 다르면 NULL 을 낸다)
    expect(migration).toContain("CHECK (repo_key IS NOT DISTINCT FROM nmv_repository_anchor_key(repo_key))");
    expect(migration).toContain("CHECK (value IS NOT DISTINCT FROM nmv_repository_anchor_value(kind, value))");
  });
});

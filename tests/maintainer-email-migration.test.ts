import { existsSync, readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";

/**
 * 0194 제작자 이메일 표. 처음에는 0186(빈 번호, when 1794700800000)으로 만들었으나 운영은 이미 0193(when 1795219200002)까지 적용했다 —
 * drizzle migrator 는 적용된 마지막 created_at 보다 큰 when 만 적용하므로 0186 은 「완료」로 끝나며 건너뛰어지고, 배포 관문은 적용 수가 모자라 거절한다.
 * 그래서 0193 바로 뒤(0194, when 1795219200003)에 붙인다. 0193 까지 적용한 DB 에 0194 만 적용되는지는 PR 본문의 검증 기록을 본다.
 */
const tag = "0194_repository_maintainer_emails";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[] };
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");

it("registers 0194 right after 0193 with a larger when, once — never in the empty 0186 slot", () => {
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(journal.entries[index]).toEqual({ idx: 194, version: "7", when: 1795219200003, tag, breakpoints: true });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 193, when: 1795219200002, tag: "0193_japanese_abcllm_product_translation" });
  expect(journal.entries.filter(entry => entry.idx === 194 || entry.tag.includes("maintainer_email"))).toHaveLength(1);
  expect(journal.entries.some(entry => entry.idx === 186)).toBe(false);
  expect(existsSync("drizzle/0186_repository_maintainer_emails.sql")).toBe(false);
  expect(journal.entries.slice(index + 1).every(next => next.idx > 194 && next.when > journal.entries[index].when)).toBe(true);
});

it("only creates the two new tables and their indexes — no lock on existing tables, no grant, fails loudly if a stale table exists", () => {
  const statements = migration.split("--> statement-breakpoint").map(part => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);
  expect(statements.map(statement => statement.match(/^CREATE (?:TABLE|INDEX) "[a-z_]+"/)?.[0])).toEqual([
    'CREATE TABLE "repository_maintainer_emails"', 'CREATE INDEX "repository_maintainer_emails_email_idx"',
    'CREATE INDEX "repository_maintainer_emails_last_seen_idx"', 'CREATE TABLE "maintainer_email_denials"',
  ]);
  const body = statements.join("\n");
  expect(body).not.toMatch(/\b(?:ALTER|DROP|UPDATE|DELETE|TRUNCATE|GRANT|INSERT)\b|IF NOT EXISTS/i);
  // 보관 기한·거부 해시가 기대는 칸 — 시간대가 있는 시각, 해시 꼴
  expect(body).toContain('"last_seen_at" timestamptz DEFAULT now() NOT NULL');
  expect(body).toContain(`CHECK ("email_hash" ~ '^[a-f0-9]{64}$')`);
});

it("keeps the drizzle tables in step with the migration columns", () => {
  for (const table of [repositoryMaintainerEmails, maintainerEmailDenials]) {
    const config = getTableConfig(table);
    expect(migration).toContain(`CREATE TABLE "${config.name}"`);
    for (const column of config.columns) expect(migration, `${config.name}.${column.name}`).toContain(`"${column.name}"`);
    for (const column of config.columns.filter(item => item.columnType === "PgTimestamp")) {
      expect((column as unknown as { withTimezone: boolean }).withTimezone, `${config.name}.${column.name}`).toBe(true);
    }
  }
});

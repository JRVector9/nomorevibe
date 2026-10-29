import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { PRODUCTION_APPLIED_MIGRATIONS as applied } from "./fixtures/production-applied-migrations";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const files = readMigrationFiles({ migrationsFolder: "drizzle" });
const last = applied.at(-1)!;

describe("운영 적용 migration 고정", () => {
  it("고정 목록은 0부터 빈칸 없이 이어지고 when 이 계속 커진다", () => {
    expect(applied.length).toBeGreaterThanOrEqual(143);
    applied.forEach(([idx, , when], index) => {
      expect(idx).toBe(index);
      if (index) expect(when).toBeGreaterThan(applied[index - 1][2]);
    });
  });

  it("저장소 journal 의 앞부분은 운영 적용분과 tag·when·drizzle 해시가 같다", () => {
    for (const [idx, tag, when, hash] of applied) {
      const entry = journal.entries[idx];
      expect(entry, tag).toMatchObject({ idx, tag, when });
      // drizzle migrator 가 __drizzle_migrations.hash 로 넣는 값(파일 문자열의 sha256)
      expect(files[idx].hash, tag).toBe(hash);
      expect(files[idx].folderMillis, tag).toBe(when);
      // 배포 gate 가 git 에서 읽는 바이트 그대로의 sha256
      expect(createHash("sha256").update(readFileSync(`drizzle/${tag}.sql`)).digest("hex"), tag).toBe(hash);
    }
  });

  it("새 migration 은 운영 최신 when·번호 뒤에만 붙는다(같은 when 에 다른 해시 금지)", () => {
    const [lastIdx, lastTag, lastWhen] = last;
    const lockedTags = new Set(applied.map(([, tag]) => tag));
    for (const entry of journal.entries.slice(applied.length)) {
      expect(entry.idx, entry.tag).toBeGreaterThan(lastIdx);
      expect(entry.when, `${entry.tag} when must exceed ${lastTag} (${lastWhen})`).toBeGreaterThan(lastWhen);
      expect(Number(entry.tag.slice(0, 4)), entry.tag).toBeGreaterThan(lastIdx);
    }
    // 운영 번호대(0000~마지막)에 끼워 넣은 다른 SQL 파일도 거절한다
    const stray = readdirSync("drizzle").filter(name => name.endsWith(".sql") && Number(name.slice(0, 4)) <= lastIdx
      && !lockedTags.has(name.slice(0, -4)));
    expect(stray).toEqual([]);
  });
});

import { beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import {
  MAINTAINER_EMAIL_RETENTION_DAYS, maintainerEmailRetentionReady, pruneMaintainerEmailBatch, pruneMaintainerEmails,
} from "@/lib/operations/db-retention";
import { ensureSchema } from "./setup";

/** 제작자 이메일 1년 보관(0194, db-retention 의 maintainerEmails 부분) — 실제 PostgreSQL. 주소는 운영자 도메인의 시험용 하위 도메인(*.fixture.nomorevibe.com)이다 */

const always = () => true;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(repositoryMaintainerEmails);
  await db.delete(maintainerEmailDenials);
});

async function seed(rows: { key: string; email: string; lastSeenDaysAgo: number }[]) {
  await db.insert(repositoryMaintainerEmails).values(rows.map((row) => ({ repositoryKey: row.key, email: row.email, commitCount: 1,
    firstSeenAt: ago(row.lastSeenDaysAgo + 30), lastSeenAt: ago(row.lastSeenDaysAgo) })));
}
const left = async () => (await db.select({ email: repositoryMaintainerEmails.email }).from(repositoryMaintainerEmails)).map((row) => row.email).sort();

it("마지막 확인 뒤 1년이 지난 행만 지운다 — 1년 안의 행과 거부 목록은 그대로", async () => {
  expect(MAINTAINER_EMAIL_RETENTION_DAYS).toBe(365);
  await seed([
    { key: "kim/old", email: "old@fixture.nomorevibe.com", lastSeenDaysAgo: 366 },
    { key: "kim/edge", email: "edge@fixture.nomorevibe.com", lastSeenDaysAgo: 364 },
    { key: "kim/fresh", email: "fresh@fixture.nomorevibe.com", lastSeenDaysAgo: 0 },
  ]);
  await db.insert(maintainerEmailDenials).values({ emailHash: "b".repeat(64), deniedAt: ago(800) });
  expect(await maintainerEmailRetentionReady()).toBe(true);
  expect(await pruneMaintainerEmails(undefined, always)).toEqual({ counts: { deleted: 1 }, caughtUp: true });
  expect(await left()).toEqual(["edge@fixture.nomorevibe.com", "fresh@fixture.nomorevibe.com"]);
  expect(await db.select().from(maintainerEmailDenials)).toHaveLength(1);
  // 지울 것이 없으면 0
  expect(await pruneMaintainerEmails(undefined, always)).toEqual({ counts: { deleted: 0 }, caughtUp: true });
});

it("묶음으로 지운다 — 오래된 것부터, 예산이 끝나면 이어 할 일이 남았다고 알린다", async () => {
  await seed([400, 390, 380].map((days, i) => ({ key: `kim/r${i}`, email: `p${i}@fixture.nomorevibe.com`, lastSeenDaysAgo: days })));
  expect(await pruneMaintainerEmailBatch(undefined, MAINTAINER_EMAIL_RETENTION_DAYS, 2)).toBe(2);
  expect(await left()).toEqual(["p2@fixture.nomorevibe.com"]);
  expect(await pruneMaintainerEmailBatch(undefined, MAINTAINER_EMAIL_RETENTION_DAYS, 2)).toBe(1);
  await seed([{ key: "kim/r9", email: "p9@fixture.nomorevibe.com", lastSeenDaysAgo: 400 }]);
  expect(await pruneMaintainerEmails(undefined, () => false)).toEqual({ counts: { deleted: 0 }, caughtUp: false });
  // 1년보다 짧은 기한으로는 부르지 못한다(소유자 결정)
  await expect(pruneMaintainerEmailBatch(undefined, 30)).rejects.toThrow("maintainer_email_retention_days_invalid");
});

it("0194 전(표가 없으면) 건너뛰고 migration_pending 을 남긴다", async () => {
  await db.execute(sql`ALTER TABLE repository_maintainer_emails RENAME TO repository_maintainer_emails_hidden`);
  try {
    expect(await maintainerEmailRetentionReady()).toBe(false);
    expect(await pruneMaintainerEmails(undefined, always)).toEqual({ counts: { skipped: "migration_pending" }, caughtUp: true });
  } finally {
    await db.execute(sql`ALTER TABLE repository_maintainer_emails_hidden RENAME TO repository_maintainer_emails`);
  }
});

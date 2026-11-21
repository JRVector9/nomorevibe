import { beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { maintainerEmailDenials, repositoryMaintainerEmails } from "@/lib/db/maintainer-email-schema";
import {
  DAILY_PASS_MS, MAINTAINER_EMAIL_RETENTION_DAYS, maintainerEmailRetentionReady, pruneMaintainerEmailBatch, pruneMaintainerEmails,
  pruneUnlistedMaintainerEmailKeys,
} from "@/lib/operations/db-retention";
import { ensureSchema, resetTables } from "./setup";

/**
 * 제작자 이메일 보관(0194, db-retention 의 maintainerEmails 부분) — 실제 PostgreSQL. 1년 지난 행, 공개 제품(seeded·verified)이 없는 저장소의 행.
 * 주소는 운영자 도메인의 시험용 하위 도메인(*.fixture.nomorevibe.com)이다
 */

const always = () => true;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const F = (local: string) => `${local}@fixture.nomorevibe.com`;

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(repositoryMaintainerEmails);
  await db.delete(maintainerEmailDenials);
});

let serial = 0;
async function product(key: string, status: "seeded" | "verified" | "unverified" | "banned" = "seeded") {
  const slug = `mer-${++serial}`;
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    repoUrl: `https://github.com/${key}`, status, source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64) });
}
async function seed(rows: { key: string; email: string; lastSeenDaysAgo: number }[]) {
  await db.insert(repositoryMaintainerEmails).values(rows.map((row) => ({ repositoryKey: row.key, email: row.email, commitCount: 1,
    firstSeenAt: ago(row.lastSeenDaysAgo + 30), lastSeenAt: ago(row.lastSeenDaysAgo) })));
}
const left = async () => (await db.select({ key: repositoryMaintainerEmails.repositoryKey, email: repositoryMaintainerEmails.email })
  .from(repositoryMaintainerEmails)).map((row) => `${row.key} ${row.email}`).sort();

it("마지막 확인 뒤 1년이 지난 행만 지운다 — 1년 안의 행과 거부 목록은 그대로", async () => {
  expect(MAINTAINER_EMAIL_RETENTION_DAYS).toBe(365);
  for (const key of ["kim/old", "kim/edge", "kim/fresh"]) await product(key);
  await seed([
    { key: "kim/old", email: F("old"), lastSeenDaysAgo: 366 },
    { key: "kim/edge", email: F("edge"), lastSeenDaysAgo: 364 },
    { key: "kim/fresh", email: F("fresh"), lastSeenDaysAgo: 0 },
  ]);
  await db.insert(maintainerEmailDenials).values({ emailHash: "b".repeat(64), deniedAt: ago(800) });
  expect(await maintainerEmailRetentionReady()).toBe(true);
  const first = await pruneMaintainerEmails(undefined, undefined, always);
  expect(first).toMatchObject({ counts: { deleted: 1, unlisted: 0, passDone: true }, caughtUp: true, state: { afterKey: "" } });
  expect(await left()).toEqual([`kim/edge ${F("edge")}`, `kim/fresh ${F("fresh")}`]);
  expect(await db.select().from(maintainerEmailDenials)).toHaveLength(1);
  // 지울 것이 없으면 0 — 「공개 제품 아님」 바퀴는 한 바퀴 뒤 하루 쉰다
  expect(await pruneMaintainerEmails(undefined, first.state, always)).toEqual({ counts: { deleted: 0, unlisted: 0, waiting: true }, caughtUp: true, state: first.state });
});

it("공개 제품(seeded·verified)이 없는 저장소의 행을 지운다 — 내려감·차단·검증 대기·후보만 있음. 공개 제품의 행은 남긴다", async () => {
  await product("kim/seeded", "seeded");
  await product("kim/verified", "verified");
  await product("kim/banned", "banned");
  await product("kim/pending", "unverified");
  // 저장소 주소를 어떻게 적었어도 같은 키(대소문자·www·끝 / ·.git)
  await db.insert(products).values({ slug: "mer-case", name: "c", url: "https://mer-case.example", tagline: "t", description: "d", category: "Dev",
    repoUrl: "http://www.github.com/Kim/Case.git", status: "verified", source: "crawler", verifyToken: "v-mer-case", editTokenHash: "a".repeat(64) });
  await seed(["kim/seeded", "kim/verified", "kim/banned", "kim/pending", "kim/no-product", "kim/case"].map((key) => ({ key, email: F(key.split("/")[1]), lastSeenDaysAgo: 1 })));
  expect(await pruneMaintainerEmails(undefined, undefined, always)).toMatchObject({ counts: { deleted: 0, unlisted: 3, passDone: true }, caughtUp: true });
  expect(await left()).toEqual([`kim/case ${F("case")}`, `kim/seeded ${F("seeded")}`, `kim/verified ${F("verified")}`]);
});

it("「공개 제품 아님」은 저장소 키 커서로 묶음씩 이어 한다 — 예산이 끝나면 이어 할 자리를 남기고, 바퀴를 마치면 하루 쉰다", async () => {
  await product("kim/b");
  await seed(["kim/a", "kim/b", "kim/c"].map((key) => ({ key, email: F(key.split("/")[1]), lastSeenDaysAgo: 1 })));
  // 묶음 하나(키 2개)만 — 커서는 DB 차례의 마지막 키
  const one = await pruneUnlistedMaintainerEmailKeys(undefined, "", 2);
  expect(one).toEqual({ examined: 2, lastKey: "kim/b", deleted: 1 });
  expect(await pruneUnlistedMaintainerEmailKeys(undefined, one.lastKey, 2)).toEqual({ examined: 1, lastKey: "kim/c", deleted: 1 });
  expect(await left()).toEqual([`kim/b ${F("b")}`]);
  // 예산이 1년 지우기에서 끝나면 바퀴 자리를 그대로 둔다
  expect(await pruneMaintainerEmails(undefined, { afterKey: "kim/a" }, () => false)).toEqual({ counts: { deleted: 0, unlisted: 0 }, caughtUp: false, state: { afterKey: "kim/a" } });
  // 하루가 지나면 다시 돈다
  const done = { afterKey: "", passDoneAt: new Date(Date.now() - DAILY_PASS_MS - 1).toISOString() };
  expect(await pruneMaintainerEmails(undefined, done, always)).toMatchObject({ counts: { unlisted: 0, passDone: true } });
  // 1년보다 짧은 기한으로는 부르지 못한다(소유자 결정)
  await expect(pruneMaintainerEmailBatch(undefined, 30)).rejects.toThrow("maintainer_email_retention_days_invalid");
});

it("1년 지우기는 묶음으로 오래된 것부터", async () => {
  for (const i of [0, 1, 2]) await product(`kim/r${i}`);
  await seed([400, 390, 380].map((days, i) => ({ key: `kim/r${i}`, email: F(`p${i}`), lastSeenDaysAgo: days })));
  expect(await pruneMaintainerEmailBatch(undefined, MAINTAINER_EMAIL_RETENTION_DAYS, 2)).toBe(2);
  expect(await left()).toEqual([`kim/r2 ${F("p2")}`]);
  expect(await pruneMaintainerEmailBatch(undefined, MAINTAINER_EMAIL_RETENTION_DAYS, 2)).toBe(1);
});

it("0194 전(표가 없으면) 건너뛰고 migration_pending 을 남긴다", async () => {
  await db.execute(sql`ALTER TABLE repository_maintainer_emails RENAME TO repository_maintainer_emails_hidden`);
  try {
    expect(await maintainerEmailRetentionReady()).toBe(false);
    expect(await pruneMaintainerEmails(undefined, undefined, always)).toEqual({ counts: { skipped: "migration_pending" }, caughtUp: true, state: undefined });
  } finally {
    await db.execute(sql`ALTER TABLE repository_maintainer_emails_hidden RENAME TO repository_maintainer_emails`);
  }
});

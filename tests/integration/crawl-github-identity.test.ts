import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, jobs } from "@/lib/db/schema";
import { dequeue as dequeueOwned, enqueue, markFrontier, putDocument, requeue, saveFetchedDocument } from "@/lib/crawl/repository";
import type { JobLease } from "@/lib/jobs/control";
import { ensureSchema } from "./setup";
import { claimFetchFixtureJob } from "./fetch-fixtures";

let fetchLease: JobLease;
const dequeue = (limit: number) => dequeueOwned(limit, undefined, fetchLease);

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  fetchLease = await claimFetchFixtureJob();
});
afterEach(async () => {
  if (fetchLease) await db.delete(jobs).where(and(eq(jobs.name, fetchLease.name), eq(jobs.leaseToken, fetchLease.token)));
});

function document(repo: string, id: number) {
  return { repo, repoMeta: { id, full_name: repo }, productUrl: null, pageStatus: null, pageMeta: null };
}

it("does not save a renamed repository a second time under a new path", async () => {
  await putDocument(document("maker/old-name", 926000001));
  await enqueue([{ repo: "maker/new-name", signal: "test" }]);
  const [claim] = await dequeue(1);

  const result = await saveFetchedDocument(claim, document("maker/new-name", 926000001));

  expect(result).toMatchObject({ duplicateOf: "maker/old-name" });
  expect(await db.select().from(crawlDocuments)).toHaveLength(1);
  expect(await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, "maker/new-name") }))
    .toMatchObject({ state: "skipped", aliasOf: "maker/old-name" });

  await requeue(["maker/new-name"]);
  const [retry] = await dequeue(1);
  await markFrontier(retry, "skipped");
  expect(await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, "maker/new-name") }))
    .toMatchObject({ aliasOf: null });
});

it("allows only one document when two aliases of the same GitHub ID finish together", async () => {
  await enqueue([
    { repo: "maker/first", signal: "test" },
    { repo: "maker/second", signal: "test" },
  ]);
  const claims = await dequeue(2);

  await Promise.all(claims.map(claim => saveFetchedDocument(claim, document(claim.repo, 926000002))));

  const documents = await db.select().from(crawlDocuments);
  expect(documents).toHaveLength(1);
  const states = (await db.select().from(crawlFrontier)).map(row => row.state).sort();
  expect(states).toEqual(["done", "skipped"]);
});

it("can refresh the existing path without treating itself as an alias", async () => {
  await putDocument(document("maker/same", 926000003));
  await enqueue([{ repo: "maker/same", signal: "test" }]);
  const [claim] = await dequeue(1);

  const result = await saveFetchedDocument(claim, {
    ...document("maker/same", 926000003), productUrl: "https://example.test",
  });

  expect(result).toEqual({ needsJudgement: true });
  expect(await db.select().from(crawlDocuments)).toHaveLength(1);
  expect(await db.query.crawlDocuments.findFirst({ where: eq(crawlDocuments.repo, "maker/same") }))
    .toMatchObject({ productUrl: "https://example.test" });
});

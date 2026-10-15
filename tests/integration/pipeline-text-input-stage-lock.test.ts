import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlTaglines, introCorrectionRequests, productIntroChecks, products } from "@/lib/db/schema";
import { pendingTaglines, recordTaglineResult, writeTaglineByHand } from "@/lib/crawl/taglines";
import { categorySourceHash, holdClassification, setManualCategory } from "@/lib/operations/categories";
import { editIntro, keepIntro } from "@/lib/domain/products/intro-editor";
import { fixIntroFromRequest } from "@/lib/domain/products/intro-requests";
import { pendingIntroChecks, recordIntroCheck } from "@/lib/domain/products/intro-checks";
import type { JobLease } from "@/lib/jobs/control";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `pr03d-text-${randomUUID().slice(0, 8)}`;
const raw = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
const jobBefore = new Map<string, postgres.JSONValue>();
const jobNames = ["crawl-tagline", "crawl-publish", "product-intro-check"];
vi.mock("server-only", () => ({}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor<T>(load: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const value = await load();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("actual_pg_barrier_not_observed");
}

async function behindStage<T>(domain: number | { productId: number }, action: () => Promise<T>, check?: () => Promise<void>): Promise<T> {
  const locked = deferred<number>();
  const release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM pipeline_stage_modes WHERE stage='ai1' FOR UPDATE`;
    locked.resolve(Number(row.pid));
    await release.promise;
  });
  void holding.catch(locked.reject);
  let result: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let finished = false;
    result = action().then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
    const state = await waitFor(async () => {
      if (finished) return "completed";
      const [row] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return row.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await observer.begin(async tx => {
      if (typeof domain === "number") {
        await tx`SELECT id FROM crawl_candidates WHERE id=${domain} FOR UPDATE NOWAIT`;
        await tx`SELECT d.id FROM crawl_documents d JOIN crawl_candidates c ON c.repo=d.repo WHERE c.id=${domain} FOR UPDATE OF d NOWAIT`;
      } else {
        const [product] = await tx`SELECT id,slug FROM products WHERE id=${domain.productId} FOR UPDATE NOWAIT`;
        const [identity] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${`product-lifecycle:${product.slug}`})) AS available`;
        expect(identity.available).toBe(true);
      }
    });
    await check?.();
  } finally {
    release.resolve();
    const cleanup = await Promise.allSettled([holding, ...(result ? [result] : [])]);
    for (const settled of cleanup) if (settled.status === "rejected") throw settled.reason;
  }
  const settled = await result!;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

async function taglineFixture(suffix: string) {
  const repo = `${prefix}/${suffix}`;
  await db.insert(crawlDocuments).values({ repo, productUrl: `https://${suffix}.pr03d.test`,
    repoMeta: { description: null, language: "TypeScript" }, pageStatus: 200,
    pageMeta: { title: "Stage test", textSample: "A source used for an independent controller regression" } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${suffix}.pr03d.test`,
    state: "needs_review", reason: "no_description", decidedBy: "auto" }).returning();
  const task = (await withTaglinePreview(candidate.id, () => pendingTaglines(2_000)))
    .find(row => row.candidate.id === candidate.id);
  expect(task).toBeDefined();
  const lease = await leaseFor("crawl-tagline");
  return { repo, task: task!, lease };
}

async function withTaglinePreview<T>(candidateId: number, preview: () => Promise<T>): Promise<T> {
  const before = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id<>${candidateId}
    AND state='needs_review' AND reason='no_description' AND decided_by IN ('auto','admin') ORDER BY id`;
  if (!before.length) return preview();
  const ids = before.map(row => Number(row.data.id));
  try {
    await raw`UPDATE crawl_candidates SET decided_by=NULL WHERE id=ANY(${ids}::int[])`;
    return await preview();
  } finally {
    await raw`UPDATE crawl_candidates c SET decided_by=s.decided_by
      FROM jsonb_populate_recordset(NULL::crawl_candidates,${raw.json(before.map(row => row.data))}) s WHERE c.id=s.id`;
    const after = await raw`SELECT to_jsonb(c) AS data FROM crawl_candidates c WHERE id=ANY(${ids}::int[]) ORDER BY id`;
    expect(after.map(row => row.data)).toEqual(before.map(row => row.data));
  }
}

async function leaseFor(name: string): Promise<JobLease> {
  const lease: JobLease = { name, token: randomUUID(), requestedVersion: 7 };
  await raw`INSERT INTO jobs(name,lease_token,locked_at,requested_version) VALUES(${lease.name},${lease.token},clock_timestamp(),7)
    ON CONFLICT(name) DO UPDATE SET lease_token=EXCLUDED.lease_token,locked_at=EXCLUDED.locked_at,requested_version=7`;
  return lease;
}

beforeAll(async () => {
  ensureSchema();
  for (const name of jobNames) {
    const [row] = await raw`SELECT to_jsonb(j) AS data FROM jobs j WHERE name=${name}`;
    if (row) jobBefore.set(name, row.data);
  }
});

afterAll(async () => {
  try {
    await db.delete(crawlTaglines).where(like(crawlTaglines.repo, `${prefix}/%`));
    await db.delete(categoryDecisions).where(like(categoryDecisions.repo, `${prefix}/%`));
    await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}/%`));
    await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}/%`));
    await db.delete(products).where(like(products.slug, `${prefix}-%`));
    await raw`DELETE FROM cdn_purges WHERE slug LIKE ${`${prefix}-%`}`;
    for (const name of jobNames) {
      const before = jobBefore.get(name);
      if (before) {
        await raw`UPDATE jobs SET requested_version=s.requested_version,updated_at=s.updated_at,locked_at=s.locked_at,lease_token=s.lease_token
          FROM jsonb_populate_record(NULL::jobs,${raw.json(before)}) s WHERE jobs.name=${name}`;
        const [after] = await raw`SELECT to_jsonb(j) AS data FROM jobs j WHERE name=${name}`;
        expect(after.data).toEqual(before);
      } else await raw`DELETE FROM jobs WHERE name=${name}`;
    }
    const [remaining] = await raw`SELECT
      (SELECT count(*)::int FROM crawl_candidates WHERE repo LIKE ${`${prefix}/%`}) AS candidates,
      (SELECT count(*)::int FROM crawl_documents WHERE repo LIKE ${`${prefix}/%`}) AS documents,
      (SELECT count(*)::int FROM crawl_taglines WHERE repo LIKE ${`${prefix}/%`}) AS taglines,
      (SELECT count(*)::int FROM category_decisions WHERE repo LIKE ${`${prefix}/%`}) AS categories,
      (SELECT count(*)::int FROM products WHERE slug LIKE ${`${prefix}-%`}) AS products,
      (SELECT count(*)::int FROM intro_correction_requests WHERE slug LIKE ${`${prefix}-%`}) AS requests,
      (SELECT count(*)::int FROM cdn_purges WHERE slug LIKE ${`${prefix}-%`}) AS purges,
      (SELECT count(*)::int FROM pipeline_item_leases WHERE owner_instance_id=${prefix}) AS items`;
    expect(remaining).toEqual({ candidates: 0, documents: 0, taglines: 0, categories: 0, products: 0, requests: 0, purges: 0, items: 0 });
  } finally {
    await Promise.all([raw.end(), blocker.end(), observer.end()]);
  }
});

it("normal tagline result control commits candidate, text and publish request", async () => {
  const fixture = await taglineFixture("control");
  expect(await recordTaglineResult(fixture.task, fixture.lease,
    { kind: "success", tagline: "독립 회귀를 위한 소개", source: "page", model: "fixture" }))
    .toEqual({ stored: true, released: true });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, fixture.task.candidate.id)))[0].state).toBe("approved");
  expect((await db.select().from(crawlTaglines).where(eq(crawlTaglines.repo, fixture.repo)))[0].tagline).toBe("독립 회귀를 위한 소개");
});

it("crowded selector keeps the scoped tagline fixture visible behind 2000 unrelated ready rows", async () => {
  const repos = Array.from({ length: 2_000 }, (_, i) => `${prefix}/crowded-${i}`);
  await db.insert(crawlDocuments).values(repos.map(repo => ({ repo, productUrl: "https://crowded.pr03d.test",
    repoMeta: { description: null }, pageStatus: 200, pageMeta: { title: "Crowded queue", textSample: "Ready text evidence" } })));
  await db.insert(crawlCandidates).values(repos.map(repo => ({ repo, state: "needs_review" as const, reason: "no_description" as const, decidedBy: "auto" })));
  const fixture = await taglineFixture("crowded-target");
  expect(await recordTaglineResult(fixture.task, fixture.lease,
    { kind: "success", tagline: "혼잡한 대기열에서도 검증하는 자체 소개", source: "page", model: "fixture" }))
    .toEqual({ stored: true, released: true });
});

it("tagline result waits for S3 before domain locks, text or outbox", async () => {
  const fixture = await taglineFixture("barrier");
  expect(await behindStage(fixture.task.candidate.id, () => recordTaglineResult(fixture.task, fixture.lease,
    { kind: "success", tagline: "잠금 뒤에 저장하는 소개", source: "page", model: "fixture" }), async () => {
      expect(await db.select().from(crawlTaglines).where(eq(crawlTaglines.repo, fixture.repo))).toEqual([]);
      expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, fixture.task.candidate.id)))[0]).toEqual(fixture.task.candidate);
    }))
    .toEqual({ stored: true, released: true });
});

async function productFixture(suffix: string) {
  const slug = `${prefix}-${suffix}`;
  const [product] = await db.insert(products).values({ slug, name: "독립 제품", url: `https://${slug}.test`,
    repoUrl: `https://github.com/${prefix}/${suffix}`, tagline: "원래 소개의 잘못된 설명입니다", description: "원래 소개의 잘못된 설명입니다",
    taglineSource: "ai_page", category: "Dev", source: "crawler", status: "seeded", verifyToken: prefix, editTokenHash: "e" }).returning();
  return product;
}

async function introFixture(suffix: string) {
  const product = await productFixture(suffix);
  // The actual queue orders ID DESC: this freshly inserted scoped product is
  // first, including when earlier files leave more than 2000 eligible products.
  const task = (await pendingIntroChecks(2_000)).find(row => row.product.id === product.id);
  expect(task).toBeDefined();
  return { product, task: task!, lease: await leaseFor("product-intro-check") };
}

async function rawTextState(repo: string) {
  const [row] = await raw`SELECT jsonb_build_object(
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c WHERE repo=${repo}),
    'tagline',(SELECT to_jsonb(t) FROM crawl_taglines t WHERE repo=${repo}),
    'category',(SELECT to_jsonb(c) FROM category_decisions c WHERE repo=${repo}),
    'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM operations_audit a WHERE target=${repo}),
    'request',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-publish')) AS data`;
  return row.data;
}

async function rawProductState(id: number) {
  const [row] = await raw`SELECT jsonb_build_object(
    'product',(SELECT to_jsonb(p) FROM products p WHERE id=${id}),
    'check',(SELECT to_jsonb(c) FROM product_intro_checks c WHERE product_id=${id}),
    'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM product_search_profiles p WHERE product_id=${id}),
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM intro_correction_requests r WHERE product_id=${id})) AS data`;
  return row.data;
}

it("manual tagline waits for S3 before replacing the actual row", async () => {
  const fixture = await taglineFixture("manual");
  const before = await rawTextState(fixture.repo);
  await behindStage(fixture.task.candidate.id, () => writeTaglineByHand({ repo: fixture.repo, tagline: "관리자가 적은 소개",
    by: prefix, documentAt: fixture.task.document.fetchedAt }), async () => { expect(await rawTextState(fixture.repo)).toEqual(before); });
  expect((await db.select().from(crawlTaglines).where(eq(crawlTaglines.repo, fixture.repo)))[0])
    .toMatchObject({ tagline: "관리자가 적은 소개", writtenBy: prefix });
  expect(await recordTaglineResult(fixture.task, fixture.lease, { kind: "success", tagline: "늦은 결과", source: "page", model: "fixture" }))
    .toEqual({ stored: false, released: false });
});

it("category hold and manual category wait for S3 before decision/audit/request", async () => {
  const fixture = await taglineFixture("category");
  const [candidate] = await db.update(crawlCandidates).set({ state: "approved", reason: "passed" })
    .where(eq(crawlCandidates.id, fixture.task.candidate.id)).returning();
  let before = await rawTextState(fixture.repo);
  await behindStage(candidate.id, () => holdClassification(candidate, fixture.task.document), async () => {
    expect(await rawTextState(fixture.repo)).toEqual(before);
  });
  expect((await db.select().from(categoryDecisions).where(eq(categoryDecisions.repo, fixture.repo)))[0].category).toBeNull();
  before = await rawTextState(fixture.repo);
  await behindStage(candidate.id, () => setManualCategory({ repo: fixture.repo,
    sourceHash: categorySourceHash(candidate, fixture.task.document), category: "Dev", reason: "확인한 분류", actor: prefix }), async () => {
    expect(await rawTextState(fixture.repo)).toEqual(before);
  });
  expect((await db.select().from(categoryDecisions).where(eq(categoryDecisions.repo, fixture.repo)))[0].category).toBe("Dev");
});

it("intro editor waits for S3 before generation/product/check locks", async () => {
  const product = await productFixture("editor");
  await db.insert(productIntroChecks).values({ productId: product.id, checkedTagline: product.tagline, outcome: "needs_editor" });
  const before = await rawProductState(product.id);
  expect(await behindStage({ productId: product.id }, () => editIntro(product.slug, "사람이 확인하여 고친 새로운 소개입니다"), async () => {
    expect(await rawProductState(product.id)).toEqual(before);
  })).toEqual({ before: product.tagline });
});

it("intro request fix waits for S3 and closes only its own actual requests", async () => {
  const product = await productFixture("request");
  const [request] = await db.insert(introCorrectionRequests).values({ productId: product.id, slug: product.slug, message: "소개가 실제와 달라 고쳐 주세요" }).returning();
  const before = await rawProductState(product.id);
  expect(await behindStage({ productId: product.id }, () => fixIntroFromRequest(request.id, "요청을 보고 고친 정확한 소개입니다", prefix), async () => {
    expect(await rawProductState(product.id)).toEqual(before);
  })).toEqual({ slug: product.slug, before: product.tagline, closed: [request.id] });
  expect(await fixIntroFromRequest(request.id, "중복 저장을 하지 않는 소개입니다", prefix)).toBeNull();
});

it.each(["success", "failure"] as const)("intro %s result waits for S3 before product/check writes", async kind => {
  const fixture = await introFixture(`intro-${kind}`);
  const before = await rawProductState(fixture.product.id);
  const result = kind === "failure" ? { kind, error: "fixture_failure" } : { kind, model: "fixture",
    judgement: { verdict: "wrong" as const, problem: "설명이 다름", corrected: "실제 근거에 맞추어 고친 제품 소개입니다" } };
  expect(await behindStage({ productId: fixture.product.id }, () => recordIntroCheck(fixture.task, fixture.lease, result), async () => {
    expect(await rawProductState(fixture.product.id)).toEqual(before);
  })).toBe(kind === "failure" ? "failed" : "replaced");
});

it("human keep is metadata and makes a previously loaded late intro result stale", async () => {
  const fixture = await introFixture("keep");
  await recordIntroCheck(fixture.task, fixture.lease, { kind: "success", model: "fixture",
    judgement: { verdict: "wrong", problem: "근거가 부족합니다", corrected: "" } });
  const [check] = await db.select().from(productIntroChecks).where(eq(productIntroChecks.productId, fixture.product.id));
  const task = { product: fixture.task.product, check };
  expect(await keepIntro(fixture.product.slug)).toBe(true);
  const before = await rawProductState(fixture.product.id);
  expect(await recordIntroCheck(task, fixture.lease, { kind: "success", model: "fixture",
    judgement: { verdict: "wrong", problem: "늦은 결과", corrected: "늦게 도착하여 적용하면 안 되는 소개입니다" } })).toBeNull();
  expect(await rawProductState(fixture.product.id)).toEqual(before);
});

async function behindJob<T>(lease: JobLease, action: () => Promise<T>, kind: "expire" | "replace") {
  const locked = deferred<number>(), writer = deferred<number>(), changed = deferred<void>(), release = deferred<void>();
  const replacement = randomUUID();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM jobs WHERE name=${lease.name} FOR UPDATE`;
    locked.resolve(Number(row.pid));
    const writerPid = await writer.promise;
    if (writerPid > 0) {
      if (kind === "replace") await tx`UPDATE jobs SET lease_token=${replacement},locked_at=clock_timestamp() WHERE name=${lease.name}`;
      else {
        await tx`UPDATE jobs SET locked_at=(SELECT xact_start FROM pg_stat_activity WHERE pid=${writerPid})
          - ${STALE_LOCK_MS} * interval '1 millisecond' + interval '1 millisecond' WHERE name=${lease.name}`;
        const proof = await waitFor(async () => {
          const [state] = await tx`SELECT locked_at+${STALE_LOCK_MS}*interval '1 millisecond'
            > (SELECT xact_start FROM pg_stat_activity WHERE pid=${writerPid}) AS healthy_at_start,
            locked_at+${STALE_LOCK_MS}*interval '1 millisecond' <= clock_timestamp() AS expired_now
            FROM jobs WHERE name=${lease.name}`;
          return state.expired_now ? state : undefined;
        });
        expect(proof).toMatchObject({ healthy_at_start: true, expired_now: true });
      }
    }
    changed.resolve();
    await release.promise;
  });
  void holding.catch(error => { locked.reject(error); changed.reject(error); });
  let writing: Promise<{ value: T } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    writing = action().then(value => ({ value }), error => ({ error }));
    const writerPid = await waitFor(async () => {
      const [row] = await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${pid}::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%jobs%'`;
      return row ? Number(row.pid) : undefined;
    });
    writer.resolve(writerPid);
    await changed.promise;
  } finally {
    writer.resolve(0);
    release.resolve();
    const finished = await Promise.allSettled([holding, ...(writing ? [writing] : [])]);
    for (const result of finished) if (result.status === "rejected") throw result.reason;
  }
  const result = await writing!;
  expect(result).toHaveProperty("error");
  if (!("error" in result)) throw new Error("late_writer_unexpectedly_committed");
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain("job_lease_lost");
  const [job] = await raw`SELECT lease_token FROM jobs WHERE name=${lease.name}`;
  expect(job.lease_token).toBe(kind === "replace" ? replacement : lease.token);
}

it.each(["expire", "replace"] as const)("tagline result rolls text/candidate/outbox back after actual job wait and %s", async kind => {
  const fixture = await taglineFixture(`job-${kind}`);
  const before = await rawTextState(fixture.repo);
  await behindJob(fixture.lease, () => recordTaglineResult(fixture.task, fixture.lease,
    { kind: "success", tagline: "잃은 소유권으로 저장하지 않는 소개입니다", source: "page", model: "fixture" }), kind);
  expect(await rawTextState(fixture.repo)).toEqual(before);
});

it.each(["success", "failure"] as const)("intro %s rolls product/check back when job expires during an observed wait", async kind => {
  const fixture = await introFixture(`expiry-${kind}`);
  const before = await rawProductState(fixture.product.id);
  const result = kind === "failure" ? { kind, error: "fixture_failure" } : { kind, model: "fixture",
    judgement: { verdict: "wrong" as const, problem: "교정 필요", corrected: "근거에 맞추어 바꾸려는 새로운 소개입니다" } };
  await behindJob(fixture.lease, () => recordIntroCheck(fixture.task, fixture.lease, result), "expire");
  expect(await rawProductState(fixture.product.id)).toEqual(before);
});

it("tagline and manual category roll actual writes and audit back with a failing publish request", async () => {
  const tagline = await taglineFixture("request-rollback");
  const category = await taglineFixture("category-rollback");
  const [candidate] = await db.update(crawlCandidates).set({ state: "approved", reason: "passed" })
    .where(eq(crawlCandidates.id, category.task.candidate.id)).returning();
  const taglineBefore = await rawTextState(tagline.repo), categoryBefore = await rawTextState(category.repo);
  await raw`CREATE FUNCTION pr03d_text_fail_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.name='crawl-publish' THEN RAISE EXCEPTION 'pr03d_text_request_failed'; END IF; RETURN NEW; END $$`;
  try {
    await raw`CREATE TRIGGER pr03d_text_fail_request BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pr03d_text_fail_request()`;
    await expect(recordTaglineResult(tagline.task, tagline.lease,
      { kind: "success", tagline: "요청과 함께 원자적으로 저장하는 소개", source: "page", model: "fixture" }))
      .rejects.toMatchObject({ cause: { message: "pr03d_text_request_failed" } });
    expect(await rawTextState(tagline.repo)).toEqual(taglineBefore);
    await expect(setManualCategory({ repo: category.repo, sourceHash: categorySourceHash(candidate, category.task.document),
      category: "Dev", reason: "실제 수동 분류", actor: prefix })).rejects.toMatchObject({ cause: { message: "pr03d_text_request_failed" } });
    expect(await rawTextState(category.repo)).toEqual(categoryBefore);
  } finally {
    await raw`DROP TRIGGER IF EXISTS pr03d_text_fail_request ON jobs`;
    await raw`DROP FUNCTION pr03d_text_fail_request()`;
  }
});

it.each(["items", "draining"] as const)("manual/hold/intro controllers continue in %s while a live logical item is retained", async mode => {
  const fixture = await taglineFixture(`mode-${mode}`);
  const [candidate] = await db.update(crawlCandidates).set({ state: "approved", reason: "passed" })
    .where(eq(crawlCandidates.id, fixture.task.candidate.id)).returning();
  const stages = await raw`SELECT to_jsonb(s) AS data FROM pipeline_stage_modes s ORDER BY stage`;
  const { claimItemLease, lockItemStage } = await import("@/lib/jobs/items/repository");
  const owner = { instanceId: prefix, bootId: randomUUID() };
  try {
    await raw`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1`;
    const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai1"),
      { stage: "ai1", candidateId: candidate.id, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
        policyHash: "c".repeat(64), promptVersion: "fixture", rulesVersion: "fixture", reviewer: { provider: "fixture", model: "fixture" } }, owner, 60_000));
    expect(lease).not.toBeNull();
    const [before] = await raw`SELECT to_jsonb(l) AS data FROM pipeline_item_leases l WHERE owner_instance_id=${prefix} AND work_key=${`ai1:${candidate.id}`}`;
    if (mode === "draining") await raw`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items'`;
    await writeTaglineByHand({ repo: fixture.repo, tagline: "활성 소유자를 회수하지 않는 수동 소개", by: prefix, documentAt: fixture.task.document.fetchedAt });
    await holdClassification(candidate, fixture.task.document);
    await setManualCategory({ repo: fixture.repo, sourceHash: categorySourceHash(candidate, fixture.task.document),
      category: "Dev", reason: "상태와 독립적인 수동 분류", actor: prefix });
    const product = await productFixture(`mode-intro-${mode}`);
    await db.insert(productIntroChecks).values({ productId: product.id, checkedTagline: product.tagline, outcome: "needs_editor" });
    expect(await editIntro(product.slug, "stage 모드와 독립적으로 고친 소개입니다")).toEqual({ before: product.tagline });
    const automatic = await taglineFixture(`mode-auto-${mode}`);
    expect(await recordTaglineResult(automatic.task, automatic.lease,
      { kind: "success", tagline: "stage 모드와 독립적으로 저장하는 자동 소개", source: "page", model: "fixture" }))
      .toEqual({ stored: true, released: true });
    const requestProduct = await productFixture(`mode-request-${mode}`);
    const [request] = await db.insert(introCorrectionRequests).values({ productId: requestProduct.id,
      slug: requestProduct.slug, message: "관리자에게 소개 수정을 요청합니다" }).returning();
    expect(await fixIntroFromRequest(request.id, "stage 모드와 독립적으로 고친 요청 소개입니다", prefix))
      .toEqual({ slug: requestProduct.slug, before: requestProduct.tagline, closed: [request.id] });
    for (const kind of ["success", "failure"] as const) {
      const check = await introFixture(`mode-check-${kind}-${mode}`);
      const result = kind === "failure" ? { kind, error: "fixture_failure" } : { kind, model: "fixture",
        judgement: { verdict: "wrong" as const, problem: "교정 필요", corrected: "stage 모드와 독립적으로 검수하여 고친 소개입니다" } };
      expect(await recordIntroCheck(check.task, check.lease, result)).toBe(kind === "failure" ? "failed" : "replaced");
    }
    expect((await raw`SELECT to_jsonb(l) AS data FROM pipeline_item_leases l WHERE owner_instance_id=${prefix} AND work_key=${`ai1:${candidate.id}`}`)[0].data).toEqual(before.data);
  } finally {
    await raw`DELETE FROM pipeline_item_leases WHERE owner_instance_id=${prefix} AND work_key=${`ai1:${candidate.id}`}`;
    for (const row of stages) await raw`UPDATE pipeline_stage_modes p SET mode=s.mode,draining_from=s.draining_from,
      writer_contract_version=s.writer_contract_version FROM jsonb_populate_record(NULL::pipeline_stage_modes,${raw.json(row.data)}) s WHERE p.stage=s.stage`;
    expect((await raw`SELECT to_jsonb(s) AS data FROM pipeline_stage_modes s ORDER BY stage`).map(row => row.data)).toEqual(stages.map(row => row.data));
  }
});

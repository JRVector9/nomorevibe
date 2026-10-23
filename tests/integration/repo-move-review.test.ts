import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productEvidenceAudit, productMakerMembers, productRepoReviews, products, publicUsers } from "@/lib/db/schema";
import { normalizeTypedLink } from "@/lib/domain/evidence/contracts";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { applyRepoMoveResult, readRepoMoveSnapshot } from "@/lib/domain/products/repo-move-reviews";
import { buildRepoMoveInput, repoMoveSource, type RepoMoveCandidate, type RepoMoveOutcome } from "@/lib/domain/products/repo-move-review";
import { saveRepoMoveCandidate } from "@/lib/domain/products/repo-move-producer";
import { dueRepoReviews, MAX_REPO_GONE_DELISTS_PER_DAY } from "@/lib/domain/products/repo-reviews";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.execute(sql`update llm_assist_controls set mode='off',dispatch_enabled=false,apply_enabled=false,revision=1 where task='repo_move'`);
});

let serial = 0;
async function prepare(options: { unrelated?: boolean; product?: Partial<typeof products.$inferInsert>; keep?: boolean; maker?: boolean } = {}) {
  const slug = `repo-move-${++serial}`;
  const [product] = await db.insert(products).values({ slug, name: "Tool", url: `https://${slug}.example`, repoUrl: `https://github.com/old/${slug}`,
    tagline: "Draw maps", description: "Tool draws maps.", category: "Dev", status: "seeded", source: "crawler", verifyToken: slug, editTokenHash: "a".repeat(64),
    repoStatus: "not_found", repoMissingSince: new Date(Date.now() - 3 * 86_400_000), repoCheckedAt: new Date(Date.now() - 3_600_000), ...options.product }).returning();
  await db.insert(productRepoReviews).values({ productId: product.id, decision: "human", reason: "repo_moved", operatorDecision: options.keep ? "keep" : null,
    nextReviewAt: new Date(Date.now() - 60_000) });
  if (options.maker) {
    const [user] = await db.insert(publicUsers).values({ displayName: "Maker" }).returning();
    await db.insert(productMakerMembers).values({ productId: product.id, userId: user.id, role: "owner", method: "github_repo_owner", githubUserId: 7 });
  }
  const snapshot = (await readRepoMoveSnapshot(product.id))!;
  const destination = `new/${slug}`;
  const candidate: RepoMoveCandidate = { kind: "repo_move", snapshot, oldRepository: options.unrelated ? { state: "gone" } : { state: "moved", to: destination },
    candidates: [{ url: `https://github.com/${destination}`, check: { state: "alive" } }], uncheckedRepositoryUrls: [],
    page: repoMoveSource("product_page", "page", snapshot.url, "Tool draws maps.", "now", "complete", 200) };
  const readme = repoMoveSource("new_readme", "readme", `https://github.com/${destination}`,
    options.unrelated ? "An unrelated monitoring SDK." : "Tool draws maps. Original Tool repository.", "now", "complete", 200);
  const input = buildRepoMoveInput(candidate, [readme]);
  const outcome: RepoMoveOutcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "repo",
    evidence_quality: { status: "sufficient", limitations: ["none"] },
    state: options.unrelated ? { project_identity: "different", code_lineage: "independent", official_continuity: "unverified", relationship: "unrelated" }
      : { project_identity: "matches", code_lineage: "original", official_continuity: "explicit_move", relationship: "same_project" },
    evidence: [{ source_id: "new_readme", quote: readme.text, supports: ["/state/project_identity", "/state/code_lineage"] },
      ...(!options.unrelated ? [{ source_id: "old_repository", quote: input.sources[0].text, supports: ["/state/official_continuity"] }] : [])],
    action: { proposal: options.unrelated ? "delist_candidate" : "update_repo_candidate", reason_ko: "근거를 확인했습니다.", missing_items: [] } };
  return { product, candidate, input, outcome };
}
async function enable() {
  await db.execute(sql`update llm_assist_controls set mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true where task='repo_move'`);
}
async function record(tx: ProductTransaction, prepared: Awaited<ReturnType<typeof prepare>>) {
  const { candidate, input, outcome } = prepared;
  const workId = randomUUID(), resultId = randomUUID(), requestId = randomUUID();
  await tx.execute(sql`insert into llm_assist_work(id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version,state,
    claim_token,claim_job,claim_job_token,claim_requested_version,owner_instance_id,owner_boot_id,capacity_request_id,input,input_hash)
    values(${workId},'repo_move',${candidate.snapshot.id},'product-repo-review',${assistHash(candidate)},${JSON.stringify(candidate)}::jsonb,
      ${input.policyVersion},${input.promptVersion},'claimed',${randomUUID()},'llm-assist-gpu',${randomUUID()},1,'fake-owner',${randomUUID()},
      ${requestId},${JSON.stringify(input)}::jsonb,${assistInputHash(input)})`);
  await tx.execute(sql`insert into llm_assist_results(id,work_id,work_revision,capacity_request_id,backend_id,model_family,contract_hash,input_hash,prompt_hash,response_hash,outcome)
    values(${resultId},${workId},1,${requestId},'fake-gpu','qwen',${"a".repeat(64)},${assistInputHash(input)},${assistPromptHash("repo")},
      ${assistHash(outcome)},${JSON.stringify(outcome)}::jsonb)`);
  return { resultId, workId };
}
async function apply(prepared: Awaited<ReturnType<typeof prepare>>) {
  return db.transaction(async tx => applyRepoMoveResult(tx, prepared.candidate, prepared.input, prepared.outcome, await record(tx, prepared),
    { oldRepository: prepared.candidate.oldRepository, destination: { state: "alive" }, checkedAt: new Date().toISOString(),
      page: prepared.input.sources.find(source => source.sourceId === "product_page") }));
}
const current = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const audits = (slug: string) => db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, slug));

describe("저장소 공식 이전 CAS", () => {
  it("기본 off에서는 모델 결과를 후보로만 두고 URL을 바꾸지 않는다", async () => {
    const prepared = await prepare();
    expect(await apply(prepared)).toBe("candidate_only");
    expect((await current(prepared.product.id)).repoUrl).toBe(prepared.product.repoUrl);
    expect(await audits(prepared.product.slug)).toHaveLength(0);
  });

  it("공식 이전은 URL/세대·raw revision CAS와 감사가 같은 커밋에 남는다", async () => {
    const prepared = await prepare();
    await enable();
    expect(await apply(prepared)).toBe("updated");
    expect(await current(prepared.product.id)).toMatchObject({ repoUrl: prepared.candidate.candidates[0].url,
      repoLinkVersion: prepared.product.repoLinkVersion + 1, repoStatus: null, repoMissingSince: null });
    expect(await audits(prepared.product.slug)).toEqual([expect.objectContaining({ action: "product.repository.move", actor: "auto:repo-move",
      metadata: expect.objectContaining({ previousRepositoryUrl: prepared.product.repoUrl, officialEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) })]);
  });

  it("감사 기록 전후 실패는 URL 변경도 되돌린다", async () => {
    const prepared = await prepare();
    await enable();
    await expect(db.transaction(async tx => {
      expect(await applyRepoMoveResult(tx, prepared.candidate, prepared.input, prepared.outcome, await record(tx, prepared),
        { oldRepository: prepared.candidate.oldRepository, destination: { state: "alive" }, checkedAt: new Date().toISOString() })).toBe("updated");
      throw new Error("fake_commit_failure");
    })).rejects.toThrow("fake_commit_failure");
    expect((await current(prepared.product.id)).repoUrl).toBe(prepared.product.repoUrl);
    expect(await audits(prepared.product.slug)).toHaveLength(0);
  });

  it("마이크로초 차이·그사이 URL/운영자 수정은 적용하지 않는다", async () => {
    for (const mutate of ["microsecond", "url", "operator"]) {
      const prepared = await prepare();
      await enable();
      if (mutate === "microsecond") await db.execute(sql`update products set updated_at=updated_at+interval '0.000001 seconds' where id=${prepared.product.id}`);
      else if (mutate === "url") await db.update(products).set({ repoUrl: "https://github.com/operator/changed" }).where(eq(products.id, prepared.product.id));
      else await db.update(productRepoReviews).set({ operatorDecision: "keep", operatorAt: new Date() }).where(eq(productRepoReviews.productId, prepared.product.id));
      expect(await apply(prepared)).toBe("stale");
      expect(await audits(prepared.product.slug)).toHaveLength(0);
    }
  });

  it("메이커·claimed·운영자 keep과 설치형 URL을 보호한다", async () => {
    for (const options of [{ product: { source: "skill" as const } }, { product: { claimedAt: new Date() } }, { keep: true }, { maker: true }]) {
      const prepared = await prepare(options);
      await enable();
      expect(await apply(prepared)).toBe("protected");
      expect((await current(prepared.product.id)).repoUrl).toBe(prepared.product.repoUrl);
    }
    const installable = await prepare({ product: { accessMode: "installable" } });
    await enable();
    expect(await apply(installable)).toBe("candidate_only");
  });

  it("오래된 재접속·무관한 결과 binding은 적용하지 않는다", async () => {
    const prepared = await prepare();
    await enable();
    await db.transaction(async tx => {
      const binding = await record(tx, prepared);
      expect(await applyRepoMoveResult(tx, prepared.candidate, prepared.input, prepared.outcome, binding,
        { oldRepository: prepared.candidate.oldRepository, destination: { state: "alive" }, checkedAt: new Date(Date.now() - 61_000).toISOString() })).toBe("stale");
      expect(await applyRepoMoveResult(tx, prepared.candidate, prepared.input, prepared.outcome, { ...binding, resultId: randomUUID() },
        { oldRepository: prepared.candidate.oldRepository, destination: { state: "alive" }, checkedAt: new Date().toISOString() })).toBe("stale");
    });
  });

  it("unrelated의 실제 내림은 기존 100건 한도를 트랜잭션에서 지킨다", async () => {
    const prepared = await prepare({ unrelated: true });
    await enable();
    await db.insert(productEvidenceAudit).values(Array.from({ length: MAX_REPO_GONE_DELISTS_PER_DAY }, (_, index) => ({
      slug: `earlier-${index}`, actor: "auto:repo-gone", action: "admin.product.ban", reason: "repo_gone" })));
    expect(await apply(prepared)).toBe("daily_limit");
    expect((await current(prepared.product.id)).status).toBe("seeded");
  });

  it("한도 직전의 두 unrelated 결과가 경합해도 한 건만 내려 100을 지킨다", async () => {
    const first = await prepare({ unrelated: true }), second = await prepare({ unrelated: true });
    await enable();
    await db.insert(productEvidenceAudit).values(Array.from({ length: MAX_REPO_GONE_DELISTS_PER_DAY - 1 }, (_, index) => ({
      slug: `earlier-${index}`, actor: "auto:repo-gone", action: "admin.product.ban", reason: "repo_gone" })));
    expect((await Promise.all([apply(first), apply(second)])).sort()).toEqual(["daily_limit", "delisted"]);
    const [row] = await db.execute<{ count: number }>(sql`select count(*)::int count from product_evidence_audit where actor='auto:repo-gone' and action='admin.product.ban'`);
    expect(row.count).toBe(MAX_REPO_GONE_DELISTS_PER_DAY);
  });

  it("메이커가 지운 새 저장소 링크를 URL 변경으로 다시 노출하지 않는다", async () => {
    const prepared = await prepare();
    await enable();
    const key = normalizeTypedLink("repository", prepared.candidate.candidates[0].url)!.normalizedKey;
    await db.insert(productEvidenceAudit).values({ slug: prepared.product.slug, actor: "maker:test", action: "maker.links.remove", metadata: { keys: [`repository:${key}`] } });
    expect(await apply(prepared)).toBe("human");
    expect((await current(prepared.product.id)).repoUrl).toBe(prepared.product.repoUrl);
  });

  it("다른 제품을 확인해도 옛 저장소가 현재 gone이 아니면 내리지 않는다", async () => {
    const prepared = await prepare({ unrelated: true, product: { repoStatus: "ok", repoMissingSince: null } });
    await enable();
    expect(await apply(prepared)).toBe("stale");
    expect((await current(prepared.product.id)).status).toBe("seeded");
  });

  it("기존 저장소 생산자가 human 판정과 shadow 후보를 원자적으로 적는다", async () => {
    const prepared = await prepare();
    await db.execute(sql`update llm_assist_controls set mode='shadow',dispatch_enabled=true,apply_enabled=false where task='repo_move'`);
    const target = (await dueRepoReviews(8)).find(row => row.id === prepared.product.id)!;
    expect(await saveRepoMoveCandidate(target, { productId: target.id, decision: "human", reason: "repo_moved", answers: null, model: null,
      pageHttpStatus: null, finalUrl: null, pageTitle: null, pageExcerpt: "official move" }, prepared.candidate.oldRepository, null, [], [])).toBe(true);
    const [work] = await db.execute<{ source: RepoMoveCandidate }>(sql`select source from llm_assist_work where task='repo_move' and product_id=${target.id}`);
    expect(work.source.snapshot.review?.reviewedAt).toBe((await readRepoMoveSnapshot(target.id))?.review?.reviewedAt);
    expect((await current(target.id)).repoUrl).toBe(prepared.product.repoUrl);
  });

  it("DB도 repo 작업의 제품 ID·원 업무·입력 task 바인딩을 검사한다", async () => {
    const prepared = await prepare();
    const bad = { ...prepared.candidate, snapshot: { ...prepared.candidate.snapshot, id: prepared.product.id + 1 } };
    await expect(db.execute(sql`insert into llm_assist_work(id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version)
      values(${randomUUID()},'repo_move',${prepared.product.id},'product-repo-review',${assistHash(bad)},${JSON.stringify(bad)}::jsonb,'p','p')`)).rejects.toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmAssistResults, operationsAudit, products, productSearchProfiles } from "@/lib/db/schema";
import { introAssistCorrections } from "@/lib/db/intro-assist-schema";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assistHash, assistInputHash, type AssistInput, type AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { introRecheckCandidate, introRecheckCandidateSchema, introRecheckEligible, introRecheckSnapshotSchema,
  introRecheckSourceHash, introCorrectionRequestHash, validateIntroCorrection, type IntroRecheckCandidate,
  introCorrectionPromptHash, INTRO_CORRECTION_PROMPT_VERSION, type IntroRecheckSnapshot, type IntroRewriteCandidate } from "./intro-assist";

/** raw microseconds와 전체 check 행 hash를 읽는다. millisecond Date 변환은 세대 비교에 사용하지 않는다. */
export async function readIntroRecheckSnapshot(productId: number, tx: ProductTransaction | typeof db = db,
  lock: "share" | "update" = "share"): Promise<IntroRecheckSnapshot | null> {
  const [product] = await tx.select({ id: products.id, slug: products.slug, name: products.name, url: products.url, repoUrl: products.repoUrl,
    repoLinkVersion: products.repoLinkVersion,
    updatedAt: sql<string>`${products.updatedAt}::text`, tagline: products.tagline, taglineSource: products.taglineSource,
    description: products.description, status: products.status, source: products.source, claimedAt: sql<string | null>`${products.claimedAt}::text`,
    activeMaker: sql<boolean>`exists (select 1 from product_maker_members m where m.product_id=${products.id} and m.revoked_at is null)`,
    searchPageText: products.searchPageText, searchReadme: products.searchReadme }).from(products).where(eq(products.id, productId)).for(lock);
  if (!product) return null;
  const [check] = await tx.execute<{ raw: Record<string, unknown>; updated_at: string }>(sql`select to_jsonb(c) raw,
    c.updated_at::text updated_at from product_intro_checks c where c.product_id=${productId} ${sql.raw(`FOR ${lock.toUpperCase()}`)}`);
  if (!check) return null;
  return introRecheckSnapshotSchema.parse({ product, check: { updatedAt: check.updated_at, rowHash: assistHash(check.raw),
    checkedTagline: check.raw.checked_tagline, outcome: check.raw.outcome, errorCode: check.raw.error_code, attempts: check.raw.attempts } });
}

export type IntroRecheckPlan = { candidate: IntroRecheckCandidate; sourceHash: string };
export async function planIntroRechecks(productIds: readonly number[], database: typeof db = db): Promise<IntroRecheckPlan[]> {
  if (productIds.length > 50 || productIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("invalid_intro_plan_targets");
  const plans: IntroRecheckPlan[] = [];
  for (const id of [...new Set(productIds)].sort((a, b) => a - b)) {
    const snapshot = await readIntroRecheckSnapshot(id, database), candidate = snapshot && introRecheckCandidate(snapshot);
    if (candidate) plans.push({ candidate, sourceHash: introRecheckSourceHash(candidate) });
  }
  return plans;
}

/** 사람이 검토한 plan만 명시적으로 enqueue한다. Sonnet 행·attempts를 고쳐 재진입시키지 않는다. */
export async function requestIntroRecheck(plan: IntroRecheckPlan, actor: string, database: typeof db = db): Promise<"queued" | "duplicate" | "disabled" | "stale"> {
  const candidate = introRecheckCandidateSchema.parse(plan.candidate), sourceHash = introRecheckSourceHash(candidate);
  if (plan.sourceHash !== sourceHash || !actor.trim() || actor.length > 160) throw new Error("invalid_intro_recheck_plan");
  return database.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    await lockPipelineInputStages(tx);
    if (!await lockProductGeneration(tx, candidate.snapshot.product.id, candidate.snapshot.product.slug)) return "stale";
    const current = await readIntroRecheckSnapshot(candidate.snapshot.product.id, tx, "update");
    if (!current || !introRecheckEligible(current) || assistHash(current) !== assistHash(candidate.snapshot)) return "stale";
    const [control] = await tx.execute<{ mode: string; revision: number }>(sql`select mode,revision::float8 from llm_assist_controls where task='intro_recheck' for share`);
    if (!control || control.mode === "off") return "disabled";
    const [inserted] = await tx.execute<{ id: string }>(sql`insert into llm_assist_work
      (id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version,control_revision,priority)
      values (${randomUUID()},'intro_recheck',${candidate.snapshot.product.id},'product-intro-check',${sourceHash},
        ${JSON.stringify(candidate)}::jsonb,${candidate.policyVersion},${candidate.promptVersion},${control.revision},20)
      on conflict (task,product_id,source_hash) do nothing returning id`);
    if (!inserted) return "duplicate";
    await tx.insert(operationsAudit).values({ actor: actor.trim(), actorKind: "token", action: "product-intro-assist-request",
      target: candidate.snapshot.product.slug, detail: { workId: inserted.id, productId: candidate.snapshot.product.id, sourceHash,
        checkedTagline: candidate.snapshot.check.checkedTagline, checkRevision: candidate.snapshot.check.updatedAt } });
    return "queued";
  });
}

export type IntroAssistClaim = { workId: string; revision: number; claimToken: string; lease: JobLease };
export type IntroCorrectionRecord = { id: string; workId: string; productId: number; factualResultId: string; capacityRequestId: string;
  requestHash: string; promptHash: string; responseHash: string; contractHash: string; model: string; backendId: string; correction: IntroRewriteCandidate };

/** 호출 adapter가 실제 결과를 받은 뒤 저장한다. 이 insert 자체는 제품 변경 권한이 아니다. */
export async function saveIntroCorrection(tx: ProductTransaction, record: IntroCorrectionRecord): Promise<string | null> {
  const [saved] = await tx.insert(introAssistCorrections).values(record).onConflictDoNothing().returning({ id: introAssistCorrections.id });
  return saved?.id ?? null;
}

/** 사실 result와 별도 계량된 교정 result를 같은 제품/check 사진에 연결한 경우만 원자 적용한다. */
export async function applyIntroAssistCorrection(tx: ProductTransaction, claim: IntroAssistClaim, candidateValue: IntroRecheckCandidate,
  input: AssistInput, factual: AssistOutcome, correctionId: string): Promise<boolean> {
  const candidate = introRecheckCandidateSchema.parse(candidateValue), product = candidate.snapshot.product;
  const [work] = await tx.execute<{ source_hash: string; control_revision: number; input_hash: string; policy_version: string; prompt_version: string }>(sql`
    select source_hash,control_revision::float8,input_hash,policy_version,prompt_version from llm_assist_work
    where id=${claim.workId} and task='intro_recheck' and product_id=${product.id} and revision=${claim.revision}
      and state='claimed' and claim_token=${claim.claimToken} and claim_job=${claim.lease.name} and claim_job_token=${claim.lease.token}
      and claim_requested_version=${claim.lease.requestedVersion} for update`);
  if (!work || work.source_hash !== introRecheckSourceHash(candidate) || work.input_hash !== assistInputHash(input)
    || work.policy_version !== candidate.policyVersion || work.prompt_version !== candidate.promptVersion) return false;
  const [control] = await tx.execute<{ mode: string; revision: number; dispatch_enabled: boolean; apply_enabled: boolean }>(sql`
    select mode,revision::float8,dispatch_enabled,apply_enabled from llm_assist_controls where task='intro_recheck' for share`);
  if (control?.mode !== "confirm" || !control.dispatch_enabled || !control.apply_enabled || control.revision !== work.control_revision) return false;
  const [active] = await tx.execute<{ active: boolean }>(sql`select (not_before is null or not_before <= clock_timestamp()) active
    from jobs where name='product-intro-check' for share`);
  if (!active?.active) return false;
  const [correction] = await tx.select().from(introAssistCorrections).where(and(eq(introAssistCorrections.id, correctionId),
    eq(introAssistCorrections.workId, claim.workId), eq(introAssistCorrections.productId, product.id))).for("update");
  if (!correction || correction.applied || correction.requestHash !== introCorrectionRequestHash(candidate, input, factual)
    || correction.promptHash !== introCorrectionPromptHash()) return false;
  const checked = validateIntroCorrection(candidate, input, factual, correction.correction);
  if (!checked.ok) return false;
  const [facts] = await tx.select().from(llmAssistResults).where(and(eq(llmAssistResults.id, correction.factualResultId),
    eq(llmAssistResults.workId, claim.workId), eq(llmAssistResults.inputHash, assistInputHash(input)))).for("share");
  if (!facts || assistHash(facts.outcome) !== assistHash(factual)) return false;
  // 교정 호출은 사실 호출과 별개다. JSON 객체나 client timeout은 native terminal이 아니다.
  const [native] = await tx.execute<{ request_id: string }>(sql`select request_id from model_capacity_requests
    where request_id=${correction.capacityRequestId} and state='settled' and provider='local-direct'
      and dispatch_binding->>'kind'='local_model_direct'
      and dispatch_binding->'target'->>'kind'='assist'
      and dispatch_binding->'target'->>'purpose'='intro_correction'
      and dispatch_binding->'target'->>'workId'=${claim.workId}
      and dispatch_binding->'target'->>'workRevision'=${String(claim.revision)}
      and dispatch_binding->'target'->>'claimToken'=${claim.claimToken}
      and dispatch_binding->'target'->>'task'='intro_recheck'
      and dispatch_binding->'target'->>'subjectId'=${String(product.id)}
      and dispatch_binding->>'inputHash'=${correction.requestHash}
      and dispatch_binding->>'promptVersion'=${INTRO_CORRECTION_PROMPT_VERSION}
      and dispatch_binding->>'sourceRevisionHash'=${work.source_hash}
      and dispatch_binding->>'servingContractHash'=${correction.contractHash}
      and dispatch_binding->>'backendId'=${correction.backendId}
      and model=${correction.model} and terminal_evidence->>'kind'='local_model_terminal'
      and terminal_evidence->>'responseHash'=${correction.responseHash} for share`);
  if (!native || correction.capacityRequestId === facts.capacityRequestId) return false;
  await lockPipelineInputStages(tx);
  if (!await lockProductGeneration(tx, product.id, product.slug)) return false;
  const current = await readIntroRecheckSnapshot(product.id, tx, "update");
  if (!current || !introRecheckEligible(current) || assistHash(current) !== assistHash(candidate.snapshot)) return false;
  const sameText = product.description.trim() === product.tagline.trim();
  await tx.update(products).set({ tagline: checked.line, taglineSource: "ai_fixed", searchKeywords: null,
    ...(sameText ? { description: checked.line } : {}), updatedAt: sql`clock_timestamp()` }).where(eq(products.id, product.id));
  await tx.delete(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id));
  await tx.update(introAssistCorrections).set({ applied: true }).where(eq(introAssistCorrections.id, correction.id));
  await tx.insert(operationsAudit).values({ actor: "system:intro-assist", actorKind: "token", action: "product-intro-assist-corrected",
    target: product.slug, detail: { workId: claim.workId, factualResultId: facts.id, correctionId: correction.id,
      productId: product.id, beforeTagline: product.tagline, beforeSource: product.taglineSource, beforeDescription: product.description,
      afterTagline: checked.line, model: correction.model, backendId: correction.backendId, sourceHash: work.source_hash,
      originalCheckHash: candidate.snapshot.check.rowHash, originalAttempts: candidate.snapshot.check.attempts } });
  // Sonnet의 성공행·attempts·original*은 덮지 않는다. 새 감사가 원문·출처·설명과 교정 호출을 보존한다.
  await assertJobLeaseAtWallTime(tx, claim.lease);
  return true;
}

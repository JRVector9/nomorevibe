import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { buildNewsLocalizationInput, newsLocalizationSourceHash } from "@/lib/news/localization-contract";
import { lockNewsLocalizationSource, saveNewsLocalizationDraft } from "@/lib/news/localization-repository";
import { enqueueNewsLocalizationDemand, newsLocalizationBackendEnabled, newsLocalizationCandidateSchema,
  newsLocalizationCompletionSchema, recordNewsLocalizationCompletion, type NewsLocalizationCandidate,
  type NewsLocalizationControl, type NewsLocalizationQueuedWork } from "@/lib/news/localization-work";
import { assistHash, assistInputHash, type AssistInput } from "./contracts";
import { assistPromptHash } from "./prompts";

type Env = Readonly<Record<string, string | undefined>>;
const controlSchema = z.object({ mode: z.enum(["off", "shadow", "confirm"]), dispatchEnabled: z.boolean(),
  applyEnabled: z.boolean(), revision: z.number().int().positive().safe() }).strict();

export async function readNewsLocalizationRuntimeControl(tx: ProductTransaction): Promise<NewsLocalizationControl> {
  const [row] = await tx.execute(sql`select mode,dispatch_enabled as "dispatchEnabled",apply_enabled as "applyEnabled",revision::float8
    from llm_assist_controls where task='news' for share`);
  return row ? controlSchema.parse(row) : { mode: "off", dispatchEnabled: false, applyEnabled: false, revision: 1 };
}

/** 공통 claim SQL의 w/news_items alias용. 원문·공개 상태·microsecond revision을 함께 비교한다. */
export function newsLocalizationClaimEligible(): SQL<boolean> {
  return sql<boolean>`coalesce((w.task='news' and news_items.id=w.news_item_id and news_items.state in ('approved','pending')
    and news_items.url=w.source->'news'->>'url' and news_items.title=w.source->'news'->>'title'
    and news_items.summary is not distinct from w.source->'news'->>'summary'
    and news_items.state=w.source->'news'->>'state' and news_items.decided_at::text=w.source->'news'->>'revision'
    and news_items.created_at::text=w.source->'news'->>'observedAt'),false)`;
}

async function enqueueNewsWork(tx: ProductTransaction, work: NewsLocalizationQueuedWork): Promise<{ workId: string; created: boolean }> {
  const id = randomUUID();
  const [inserted] = await tx.execute<{ id: string }>(sql`insert into llm_assist_work(id,task,product_id,news_item_id,origin_job,
    source_hash,source,policy_version,prompt_version,control_revision,priority)
    values (${id}::uuid,'news',null,${work.newsItemId},'news-refresh',${work.sourceHash},${JSON.stringify(work.source)}::jsonb,
      ${work.policyVersion},${work.promptVersion},${work.controlRevision},0)
    on conflict(task,news_item_id,source_hash) do nothing returning id`);
  if (inserted) return { workId: inserted.id, created: true };
  const [existing] = await tx.execute<{ id: string }>(sql`select id from llm_assist_work
    where task='news' and news_item_id=${work.newsItemId} and source_hash=${work.sourceHash}`);
  if (!existing) throw new Error("news_localization_enqueue_conflict");
  return { workId: existing.id, created: false };
}

/** 명시 수요 TX의 첫 쓰기 연결점이다. 기존 news-refresh는 이 함수를 자동 호출하지 않는다. */
export async function enqueueNewsLocalizationRuntimeDemand(tx: ProductTransaction, newsItemId: number, options: { env?: Env } = {}) {
  if (!newsLocalizationBackendEnabled(options.env)) return { state: "disabled" as const };
  if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
  return enqueueNewsLocalizationDemand(tx, newsItemId, {
    readAssistControl: async (_task, sameTx) => readNewsLocalizationRuntimeControl(sameTx),
    loadSource: lockNewsLocalizationSource, enqueueWork: enqueueNewsWork,
  }, { enabled: true, originJob: "news-refresh" });
}

/** native dispatch와 같은 TX에서 원문·상태를 잠근다. 입력 hash만 맞는 과거 원문을 허용하지 않는다. */
export async function lockNewsLocalizationRuntimeInput(tx: ProductTransaction, candidateValue: NewsLocalizationCandidate,
  input: AssistInput, options: { env?: Env } = {}): Promise<boolean> {
  if (!newsLocalizationBackendEnabled(options.env)) return false;
  const candidate = newsLocalizationCandidateSchema.parse(candidateValue);
  const control = await readNewsLocalizationRuntimeControl(tx);
  if (control.mode === "off" || !control.dispatchEnabled) return false;
  const current = await lockNewsLocalizationSource(tx, candidate.news.id);
  return Boolean(current && current.state !== "hidden" && newsLocalizationSourceHash(current) === newsLocalizationSourceHash(candidate.news)
    && input.task === "news" && assistInputHash(input) === assistInputHash(buildNewsLocalizationInput(current)));
}

/** 원문은 DB snapshot이다. 이 경로에는 기사 재접속이나 동기 모델 호출이 없다. */
export async function collectNewsLocalizationRuntimeInput(candidateValue: NewsLocalizationCandidate, options: { env?: Env } = {}):
  Promise<{ kind: "ready"; input: AssistInput } | { kind: "disabled" | "obsolete"; reason: string }> {
  if (!newsLocalizationBackendEnabled(options.env)) return { kind: "disabled", reason: "news_localization_disabled" };
  const candidate = newsLocalizationCandidateSchema.parse(candidateValue), input = buildNewsLocalizationInput(candidate.news);
  return await db.transaction(tx => lockNewsLocalizationRuntimeInput(tx, candidate, input, options))
    ? { kind: "ready", input } : { kind: "obsolete", reason: "news_localization_source_or_control_changed" };
}

/** common result 선insert와 같은 TX에서 실제 settled native 호출에 묶인 초안만 저장한다. 게시 권한은 없다. */
export async function completeNewsLocalizationRuntime(tx: ProductTransaction, value: unknown, options: { env?: Env } = {}) {
  if (!newsLocalizationBackendEnabled(options.env)) return { state: "disabled" as const };
  const parsed = newsLocalizationCompletionSchema.safeParse(value);
  if (!parsed.success || parsed.data.outcome === undefined) return { state: "invalid_completion" as const };
  const completion = parsed.data;
  if (completion.promptHash !== assistPromptHash("news")) return { state: "unverified_result" as const };
  const [native] = await tx.execute(sql`select r.id from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    join llm_assist_controls c on c.task=w.task and c.mode in ('shadow','confirm') and c.dispatch_enabled and c.revision=w.control_revision
    join model_capacity_requests m on m.request_id=r.capacity_request_id and m.request_id=w.capacity_request_id
    where r.id=${completion.resultId}::uuid and w.id=${completion.workId}::uuid and w.task='news' and w.state='claimed'
      and r.work_revision=w.revision and w.news_item_id=${completion.source.news.id} and w.product_id is null
      and w.source=${JSON.stringify(completion.source)}::jsonb and w.source_hash=${completion.sourceHash}
      and w.input_hash=r.input_hash and r.input_hash=${completion.inputHash}
      and w.policy_version=${completion.policyVersion} and w.prompt_version=${completion.promptVersion}
      and r.contract_hash=${completion.contractHash} and r.prompt_hash=${completion.promptHash} and r.response_hash=${completion.responseHash}
      and r.backend_id=${completion.backendId} and r.model_family=${completion.modelFamily}
      and r.outcome=${JSON.stringify(completion.outcome)}::jsonb and m.state='settled' and m.provider='local-direct'
      and m.model=${completion.modelId} and m.dispatch_binding->>'kind'='local_model_direct'
      and m.dispatch_binding->'target'->>'kind'='assist' and m.dispatch_binding->'target'->>'purpose'='assist_review'
      and m.dispatch_binding->'target'->>'task'='news' and m.dispatch_binding->'target'->>'subjectId'=w.news_item_id::text
      and m.dispatch_binding->'target'->>'backendId'=r.backend_id
      and m.dispatch_binding->'target'->>'workId'=w.id::text and m.dispatch_binding->'target'->>'workRevision'=w.revision::text
      and m.dispatch_binding->'target'->>'claimToken'=w.claim_token::text and m.dispatch_binding->>'inputHash'=r.input_hash
      and m.dispatch_binding->>'sourceRevisionHash'=w.source_hash and m.dispatch_binding->>'servingContractHash'=r.contract_hash
      and m.dispatch_binding->>'backendId'=r.backend_id and m.terminal_evidence->>'kind'='local_model_terminal'
      and m.terminal_evidence->>'responseHash'=r.response_hash for share of r,w,c,m`);
  if (!native) return { state: "unverified_result" as const };
  // 새 source snapshot이나 hidden은 기존 domain hook에서 다시 거른다.
  return recordNewsLocalizationCompletion(tx, completion, {
    readAssistControl: async (_task, sameTx) => readNewsLocalizationRuntimeControl(sameTx),
    loadSource: lockNewsLocalizationSource, saveDraft: saveNewsLocalizationDraft,
  }, { enabled: true });
}

/** 후보 sourceHash는 공통 JSON hash와 다르다. 뉴스 정책까지 포함한 원문 hash를 사용한다. */
export function newsLocalizationRuntimeSourceHash(candidateValue: NewsLocalizationCandidate): string {
  return newsLocalizationSourceHash(newsLocalizationCandidateSchema.parse(candidateValue).news);
}

export function newsLocalizationRuntimeInputMatches(candidateValue: NewsLocalizationCandidate, input: AssistInput): boolean {
  const candidate = newsLocalizationCandidateSchema.parse(candidateValue);
  return input.task === "news" && assistHash(input) === assistInputHash(buildNewsLocalizationInput(candidate.news));
}

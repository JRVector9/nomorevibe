import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";
import { extractTextSample } from "@/lib/net/normalize";
import { requestRender, screenRenderConfig } from "@/lib/screen-review/render-client";
import { assistHash, assistInputHash, assistInputSchema, assistOutcomeSchema, type AssistInput, type AssistOutcome,
  type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { localModelContractHash, localModelThinkingFields, validateLocalModelRequest, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { buildIntroAssistInput, buildIntroCorrectionMessages, introCorrectionPromptHash, introCorrectionRequestHash,
  introRecheckCandidateSchema, introRecheckEligible, introRecheckSourceHash, introRewriteCandidateSchema,
  INTRO_CORRECTION_PROMPT_VERSION, validateIntroAssistInput, validateIntroCorrection, type IntroRecheckCandidate } from "./intro-assist";
import { applyIntroAssistCorrection, readIntroRecheckSnapshot, saveIntroCorrection, type IntroAssistClaim,
  type IntroCorrectionRecord } from "./intro-assist-repository";

type CollectionOptions = { fetch?: typeof fetchCapped; render?: typeof requestRender;
  env?: Readonly<Record<string, string | undefined>> };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sameUrl = (first: string, second: string) => new URL(first).href === new URL(second).href;

function collectedSource(id: string, kind: AssistSource["kind"], requestedUrl: string, fetched: CappedFetchResult, readme = false): AssistSource {
  const observedAt = new Date().toISOString();
  if (!fetched.ok) return { sourceId: id, kind, url: requestedUrl, observedAt, revision: assistHash({ requestedUrl, observedAt, failure: fetched }),
    text: "", completeness: fetched.reason === "http" && [401, 403, 429, 999].includes(fetched.status) ? "blocked" : "missing",
    httpStatus: fetched.reason === "http" ? fetched.status : null };
  const raw = fetched.body.toString("utf8"), text = readme ? raw.trim() : extractTextSample(raw, 32_001) ?? "";
  const blocked = /(?:verify you are human|checking your browser|just a moment|captcha|보안 확인)/i.test(text.slice(0, 2000));
  // 실제 전송 주소를 보존한다. 예상 밖 redirect는 complete가 아니다.
  const redirected = !sameUrl(fetched.finalUrl, requestedUrl);
  return { sourceId: id, kind, url: fetched.finalUrl, observedAt, text: text.slice(0, 32_000), httpStatus: fetched.status,
    revision: assistHash({ requestedUrl, finalUrl: fetched.finalUrl, status: fetched.status, observedAt, bodyHash: digest(fetched.body) }),
    completeness: blocked ? "blocked" : fetched.truncated || redirected || text.length > 32_000 ? "truncated" : text ? "complete" : "missing" };
}

/** 네트워크 동안 DB 연결을 잡지 않는다. 검색 발췌는 complete로 승격하지 않는다. */
export async function collectIntroRecheckInput(value: IntroRecheckCandidate, signal?: AbortSignal, options: CollectionOptions = {}): Promise<AssistInput> {
  const candidate = introRecheckCandidateSchema.parse(value), product = candidate.snapshot.product, fetchSource = options.fetch ?? fetchCapped;
  const load = async (url: string): Promise<CappedFetchResult> => {
    if (signal?.aborted) return { ok: false, reason: "timeout" };
    try { return await fetchSource(url, { maxBytes: 512_000, timeoutMs: 8_000, signal, allowTruncatedBody: true }); }
    catch { return { ok: false, reason: "timeout" }; }
  };
  const readme = async (): Promise<AssistSource | null> => {
    if (!product.repoUrl) return null;
    const repo = new URL(product.repoUrl), match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(repo.pathname);
    if (repo.protocol !== "https:" || repo.hostname !== "github.com" || repo.port && repo.port !== "443"
      || repo.username || repo.password || repo.search || repo.hash || !match) return null;
    const rawUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2].replace(/\.git$/, "")}/HEAD/README.md`;
    return collectedSource("current-readme", "readme", rawUrl, await load(rawUrl), true);
  };
  const [page, currentReadme] = await Promise.all([load(product.url).then(fetched => collectedSource("current-page", "page", product.url, fetched)), readme()]);
  const sources: AssistSource[] = [page, ...(currentReadme ? [currentReadme] : [])];
  const config = screenRenderConfig(options.env ?? process.env);
  if (config && !signal?.aborted && (page.completeness !== "complete" || page.text.length < 120)) {
    const observedAt = new Date().toISOString();
    const rendered = await (options.render ?? requestRender)(product.url, { config, timeoutMs: 30_000, signal });
    if (rendered.ok) sources.push({ sourceId: "current-rendered-page", kind: "rendered_page", url: rendered.finalUrl,
      observedAt, text: rendered.text, httpStatus: rendered.status,
      revision: assistHash({ observedAt, finalUrl: rendered.finalUrl, text: rendered.text, textLength: rendered.textLength, imageHash: digest(rendered.jpeg) }),
      completeness: !sameUrl(rendered.finalUrl, product.url) || rendered.textLength > rendered.text.length
        || rendered.status === null || rendered.status < 200 || rendered.status >= 400 ? "truncated"
        : rendered.text.trim() ? "complete" : "missing" });
    else sources.push({ sourceId: "current-rendered-page", kind: "rendered_page", url: product.url, observedAt,
      revision: assistHash({ observedAt, error: rendered.code }), text: "", httpStatus: null,
      completeness: rendered.kind === "page" && /blocked|403|429/.test(rendered.code) ? "blocked" : "missing" });
  }
  return buildIntroAssistInput(candidate, sources);
}

export type IntroCorrectionCapacityInput = { kind: "llm_assist_correction"; input: AssistInput; factualResultId: string; factual: AssistOutcome;
  inputHash: string; sourceRevisionHash: string; policyHash: string };
export function introCorrectionCapacityInput(candidateValue: IntroRecheckCandidate, inputValue: AssistInput, factualResultId: string,
  factualValue: AssistOutcome): IntroCorrectionCapacityInput {
  const candidate = introRecheckCandidateSchema.parse(candidateValue), input = assistInputSchema.parse(inputValue), factual = assistOutcomeSchema.parse(factualValue);
  z.uuid().parse(factualResultId);
  buildIntroCorrectionMessages(candidate, input, factual);
  return { kind: "llm_assist_correction", input, factualResultId, factual, inputHash: introCorrectionRequestHash(candidate, input, factual),
    sourceRevisionHash: introRecheckSourceHash(candidate), policyHash: assistHash({ policyVersion: candidate.policyVersion }) };
}

const targetSchema = z.object({ workId: z.uuid(), workRevision: z.number().int().positive().safe(), claimToken: z.uuid(),
  task: z.literal("intro_recheck"), subjectId: z.number().int().positive().safe(), backendId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) }).strict();
export type IntroCorrectionTarget = z.infer<typeof targetSchema>;

/** 새 요청의 실제 dispatch TX에서만 사용한다. first request의 종료를 재사용해 교정 호출을 정산하지 않는다. */
export async function proveIntroCorrectionDomain(tx: ProductTransaction, targetValue: IntroCorrectionTarget,
  value: IntroCorrectionCapacityInput, job: JobLease, role: RoleLease): Promise<boolean> {
  const target = targetSchema.parse({ workId: targetValue.workId, workRevision: targetValue.workRevision, claimToken: targetValue.claimToken,
    task: targetValue.task, subjectId: targetValue.subjectId, backendId: targetValue.backendId });
  if (role.role !== "reviewer" || job.name !== "product-llm-assist-review") return false;
  const [initial] = await tx.execute<{ source: unknown }>(sql`select source from llm_assist_work where id=${target.workId}`);
  const parsed = introRecheckCandidateSchema.safeParse(initial?.source);
  if (!parsed.success) return false;
  const candidate = parsed.data, product = candidate.snapshot.product;
  if (product.id !== target.subjectId || !validateIntroAssistInput(candidate, value.input)) return false;
  let expected: IntroCorrectionCapacityInput;
  try { expected = introCorrectionCapacityInput(candidate, value.input, value.factualResultId, value.factual); } catch { return false; }
  if (assistHash(expected) !== assistHash(value)) return false;
  await lockPipelineInputStages(tx);
  if (!await lockProductGeneration(tx, product.id, product.slug)) return false;
  const [work] = await tx.execute<{ input: unknown; source: unknown; input_hash: string; source_hash: string; policy_version: string; prompt_version: string;
    control_revision: number; capacity_request_id: string | null }>(sql`select input,source,input_hash,source_hash,policy_version,prompt_version,
      control_revision::float8,capacity_request_id::text from llm_assist_work where id=${target.workId} and task='intro_recheck'
      and product_id=${product.id} and state='claimed' and revision=${target.workRevision} and claim_token=${target.claimToken}
      and claim_job=${job.name} and claim_job_token=${job.token} and claim_requested_version=${job.requestedVersion}
      and owner_instance_id=${role.instanceId} and owner_boot_id=${role.bootId} and backend_id=${target.backendId} for update`);
  if (!work || assistHash(work.source) !== assistHash(candidate) || work.input_hash !== assistInputHash(value.input) || assistHash(work.input) !== assistHash(value.input)
    || work.source_hash !== expected.sourceRevisionHash || work.policy_version !== candidate.policyVersion || work.prompt_version !== candidate.promptVersion) return false;
  const [control] = await tx.execute<{ mode: string; dispatch_enabled: boolean; revision: number }>(sql`
    select mode,dispatch_enabled,revision::float8 from llm_assist_controls where task='intro_recheck' for share`);
  if (!control || control.mode === "off" || !control.dispatch_enabled || control.revision !== work.control_revision) return false;
  const active = await tx.execute<{ name: string }>(sql`select name from jobs
    where name in (${job.name},'product-intro-check') and (not_before is null or not_before<=clock_timestamp()) for share`);
  if (active.length !== 2) return false;
  const current = await readIntroRecheckSnapshot(product.id, tx, "update");
  if (!current || !introRecheckEligible(current) || assistHash(current) !== assistHash(candidate.snapshot)) return false;
  const [factual] = await tx.execute<{ outcome: unknown; capacity_request_id: string }>(sql`
    select r.outcome,r.capacity_request_id::text from llm_assist_results r join model_capacity_requests n on n.request_id=r.capacity_request_id
    where r.id=${value.factualResultId} and r.work_id=${target.workId} and r.work_revision=${target.workRevision}
      and r.input_hash=${assistInputHash(value.input)} and r.prompt_hash=${assistPromptHash("intro")} and not r.applied
      and r.model_family='qwen3.8-flash-next'
      and coalesce(nullif(to_jsonb(r)->'input','null'::jsonb),${JSON.stringify(value.input)}::jsonb)=${JSON.stringify(value.input)}::jsonb
      and n.state='settled' and n.provider='local-direct' and n.terminal_evidence_hash is not null
      and n.dispatch_binding->>'kind'='local_model_direct' and n.dispatch_binding->'target'->>'kind'='assist'
      and n.dispatch_binding->'target'->>'purpose'='assist_review' and n.dispatch_binding->'target'->>'task'='intro_recheck'
      and n.dispatch_binding->'target'->>'workId'=${target.workId} and n.dispatch_binding->'target'->>'workRevision'=${String(target.workRevision)}
      and n.dispatch_binding->'target'->>'claimToken'=${target.claimToken} and n.dispatch_binding->'target'->>'subjectId'=${String(product.id)}
      and n.dispatch_binding->>'inputHash'=r.input_hash and n.dispatch_binding->>'backendId'=r.backend_id
      and n.dispatch_binding->>'sourceRevisionHash'=${work.source_hash} and n.dispatch_binding->>'servingContractHash'=r.contract_hash
      and n.dispatch_binding->'job'->>'token'=${job.token} and n.owner_instance_id=${role.instanceId} and n.owner_boot_id=${role.bootId}
      and n.terminal_evidence->>'kind'='local_model_terminal' and n.terminal_evidence->>'responseHash'=r.response_hash for share of r,n`);
  if (!factual || assistHash(factual.outcome) !== assistHash(value.factual)
    || work.capacity_request_id !== null && work.capacity_request_id !== factual.capacity_request_id) return false;
  await assertJobLeaseAtWallTime(tx, job, "update");
  await assertRoleLease(tx, role);
  return true;
}

export type IntroCorrectionModelPlan = { capacityInput: IntroCorrectionCapacityInput; wire: string; wireHash: string;
  promptVersion: typeof INTRO_CORRECTION_PROMPT_VERSION; promptHash: string; contract: LocalModelServingContract };
export function buildIntroCorrectionModelPlan(candidate: IntroRecheckCandidate, input: AssistInput, factualResultId: string,
  factual: AssistOutcome, contract: LocalModelServingContract): IntroCorrectionModelPlan {
  if (contract.modelFamily !== "qwen3.8-flash-next" || !contract.capabilities.jsonSchema) throw new Error("intro_correction_qwen_contract_required");
  const capacityInput = introCorrectionCapacityInput(candidate, input, factualResultId, factual);
  const body = { model: contract.model, messages: buildIntroCorrectionMessages(candidate, input, factual), temperature: 0, stream: false,
    max_tokens: Math.min(2048, contract.maxOutputTokens), response_format: { type: "json_schema", json_schema: { name: "intro_correction",
      strict: true, schema: z.toJSONSchema(introRewriteCandidateSchema) } }, ...localModelThinkingFields(contract) };
  const wire = JSON.stringify(body), inputBytes = Buffer.byteLength(wire);
  const allowed = validateLocalModelRequest(contract, { model: contract.model, inputBytes, estimatedInputTokens: inputBytes,
    maxOutputTokens: body.max_tokens, jsonSchema: true });
  if (!allowed.ok) throw new Error(`intro_correction_${allowed.error}`);
  return { capacityInput, wire, wireHash: digest(wire), promptVersion: INTRO_CORRECTION_PROMPT_VERSION,
    promptHash: introCorrectionPromptHash(), contract };
}

export type IntroCorrectionStageSuccess = { ok: true; record: IntroCorrectionRecord; wireHash: string };
/** executeNative는 부모의 공통 계량 adapter다. 이 응답 자체는 제품 적용 권한이 아니다. */
export async function runIntroCorrectionStage(args: { candidate: IntroRecheckCandidate; input: AssistInput; factualResultId: string;
  factual: AssistOutcome; workId: string; contract: LocalModelServingContract }, executeNative:
  (plan: IntroCorrectionModelPlan) => Promise<{ capacityRequestId: string; response: Response }>):
  Promise<IntroCorrectionStageSuccess | { ok: false; error: string }> {
  z.uuid().parse(args.workId);
  const plan = buildIntroCorrectionModelPlan(args.candidate, args.input, args.factualResultId, args.factual, args.contract);
  const native = await executeNative(plan), raw = await native.response.text();
  if (!native.response.ok) return { ok: false, error: "intro_correction_http" };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, error: "intro_correction_json" }; }
  const response = z.object({ model: z.string(), choices: z.array(z.object({ finish_reason: z.literal("stop"),
    message: z.object({ content: z.string() }).passthrough() }).passthrough()).length(1) }).passthrough().safeParse(data);
  if (!response.success || response.data.model !== args.contract.responseModel) return { ok: false, error: "intro_correction_incomplete" };
  let value: unknown;
  try { value = JSON.parse(response.data.choices[0].message.content); } catch { return { ok: false, error: "intro_correction_json" }; }
  const checked = validateIntroCorrection(args.candidate, args.input, args.factual, value);
  if (!checked.ok) return { ok: false, error: checked.error };
  z.uuid().parse(native.capacityRequestId);
  return { ok: true, wireHash: plan.wireHash, record: { id: randomUUID(), workId: args.workId,
    productId: args.candidate.snapshot.product.id, factualResultId: args.factualResultId, capacityRequestId: native.capacityRequestId,
    requestHash: plan.capacityInput.inputHash, promptHash: plan.promptHash, responseHash: digest(raw),
    contractHash: localModelContractHash(args.contract), model: args.contract.model, backendId: args.contract.backendId, correction: checked.correction } };
}

/** same-TX completion은 실제 별도 settled 호출과 현재 claim을 먼저 검증하고 기존 서버 적용 guard를 재사용한다. */
export async function completeIntroCorrectionStage(tx: ProductTransaction, claim: IntroAssistClaim, candidate: IntroRecheckCandidate,
  input: AssistInput, factual: AssistOutcome, result: IntroCorrectionStageSuccess): Promise<{ recorded: boolean; applied: boolean; correctionId: string | null }> {
  const record = result.record, product = candidate.snapshot.product;
  if (record.workId !== claim.workId || record.productId !== product.id || record.requestHash !== introCorrectionRequestHash(candidate, input, factual)
    || record.promptHash !== introCorrectionPromptHash() || !validateIntroCorrection(candidate, input, factual, record.correction).ok)
    return { recorded: false, applied: false, correctionId: null };
  await lockPipelineInputStages(tx);
  if (!await lockProductGeneration(tx, product.id, product.slug)) return { recorded: false, applied: false, correctionId: null };
  const [bound] = await tx.execute<{ id: string }>(sql`select w.id from llm_assist_work w join llm_assist_results f on f.id=${record.factualResultId}
    join model_capacity_requests fn on fn.request_id=f.capacity_request_id
    join model_capacity_requests n on n.request_id=${record.capacityRequestId}
    where w.id=${claim.workId} and w.task='intro_recheck' and w.state='claimed' and w.revision=${claim.revision}
      and w.claim_token=${claim.claimToken} and w.claim_job=${claim.lease.name} and w.claim_job_token=${claim.lease.token}
      and w.claim_requested_version=${claim.lease.requestedVersion} and w.source_hash=${introRecheckSourceHash(candidate)}
      and w.input_hash=${assistInputHash(input)} and w.capacity_request_id=n.request_id and f.work_id=w.id and f.work_revision=w.revision
      and f.input_hash=w.input_hash and f.outcome=${JSON.stringify(factual)}::jsonb and f.capacity_request_id<>n.request_id
      and f.prompt_hash=${assistPromptHash("intro")} and fn.state='settled' and fn.provider='local-direct'
      and fn.terminal_evidence->>'kind'='local_model_terminal' and fn.terminal_evidence->>'responseHash'=f.response_hash
      and n.state='settled' and n.provider='local-direct' and n.terminal_evidence_hash is not null
      and n.dispatch_binding->>'kind'='local_model_direct' and n.dispatch_binding->'target'->>'kind'='assist'
      and n.dispatch_binding->'target'->>'purpose'='intro_correction' and n.dispatch_binding->'target'->>'task'='intro_recheck'
      and n.dispatch_binding->'target'->>'workId'=${claim.workId} and n.dispatch_binding->'target'->>'workRevision'=${String(claim.revision)}
      and n.dispatch_binding->'target'->>'claimToken'=${claim.claimToken} and n.dispatch_binding->'target'->>'subjectId'=${String(product.id)}
      and n.dispatch_binding->'target'->>'backendId'=${record.backendId} and n.dispatch_binding->>'backendId'=${record.backendId}
      and n.dispatch_binding->>'inputHash'=${record.requestHash} and n.dispatch_binding->>'sourceRevisionHash'=w.source_hash
      and n.dispatch_binding->>'promptVersion'=${INTRO_CORRECTION_PROMPT_VERSION} and n.dispatch_binding->>'wireHash'=${result.wireHash}
      and n.dispatch_binding->>'servingContractHash'=${record.contractHash} and n.model=${record.model}
      and n.terminal_evidence->>'kind'='local_model_terminal' and n.terminal_evidence->>'responseHash'=${record.responseHash} for update of w`);
  if (!bound) return { recorded: false, applied: false, correctionId: null };
  await assertJobLeaseAtWallTime(tx, claim.lease);
  const correctionId = await saveIntroCorrection(tx, record);
  if (!correctionId) return { recorded: false, applied: false, correctionId: null };
  const applied = await applyIntroAssistCorrection(tx, claim, candidate, input, factual, correctionId);
  await assertJobLeaseAtWallTime(tx, claim.lease);
  return { recorded: true, applied, correctionId };
}

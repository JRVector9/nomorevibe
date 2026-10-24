import { z } from "zod";
import { assistInputHash, assistOutcomeSchemas } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { buildNewsLocalizationInput, NEWS_LOCALIZATION_POLICY_VERSION, newsLocalizationSourceHash,
  newsLocalizationSourceSchema, type NewsLocalizationOutcome, type NewsLocalizationSource,
  type NewsLocalizationValidation } from "./localization-contract";
import { validateNewsLocalization } from "./localization-facts";

/** 공통 큐의 typed news_item 대상. 원문과 공개 상태를 함께 고정한다. */
export const newsLocalizationCandidateSchema = z.object({ kind: z.literal("news"), locale: z.literal("ko"),
  news: newsLocalizationSourceSchema }).strict();
export type NewsLocalizationCandidate = Readonly<z.infer<typeof newsLocalizationCandidateSchema>>;
export type NewsLocalizationControl = Readonly<{ mode: "off" | "shadow" | "confirm";
  dispatchEnabled: boolean; applyEnabled: boolean; revision: number }>;
export type NewsLocalizationQueuedWork = Readonly<{ task: "news"; newsItemId: number; originJob: string;
  source: NewsLocalizationCandidate; sourceHash: string; policyVersion: string; promptVersion: string; controlRevision: number }>;

export function newsLocalizationBackendEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.NEWS_LOCALIZATION_BACKEND_ENABLED === "true";
}

export type NewsLocalizationQueueDependencies<Tx> = {
  readAssistControl(task: "news", tx: Tx): Promise<NewsLocalizationControl>;
  /** 구현은 같은 TX에서 news_items를 FOR SHARE로 잠근다. */
  loadSource(tx: Tx, newsItemId: number): Promise<NewsLocalizationSource | null>;
  /** 공통 큐의 news_item/source_hash 고유 제약으로 중복 요청을 합친다. 모델을 호출하지 않는다. */
  enqueueWork(tx: Tx, work: NewsLocalizationQueuedWork): Promise<{ workId: string; created: boolean }>;
};

/** 기존 news-refresh에 모델 대기를 넣지 않는 수요 producer. 누락 설정은 항상 off다. */
export async function enqueueNewsLocalizationDemand<Tx>(tx: Tx, newsItemId: number,
  dependencies: NewsLocalizationQueueDependencies<Tx>, options: { enabled?: boolean; originJob?: string } = {}):
  Promise<{ state: "disabled" | "missing_source" | "hidden" } | { state: "queued"; workId: string; created: boolean }> {
  if (!(options.enabled ?? newsLocalizationBackendEnabled())) return { state: "disabled" };
  if (!Number.isSafeInteger(newsItemId) || newsItemId < 1) throw new Error("invalid_news_localization_target");
  const control = await dependencies.readAssistControl("news", tx);
  if (control.mode === "off" || !control.dispatchEnabled) return { state: "disabled" };
  const value = await dependencies.loadSource(tx, newsItemId);
  if (!value) return { state: "missing_source" };
  const source = newsLocalizationSourceSchema.parse(value);
  if (source.id !== newsItemId) throw new Error("news_localization_target_mismatch");
  if (source.state === "hidden") return { state: "hidden" };
  const queued = await dependencies.enqueueWork(tx, { task: "news", newsItemId, originJob: options.originJob ?? "news-refresh",
    source: { kind: "news", locale: "ko", news: source }, sourceHash: newsLocalizationSourceHash(source),
    policyVersion: NEWS_LOCALIZATION_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION, controlRevision: control.revision });
  return { state: "queued", ...queued };
}

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const newsLocalizationCompletionSchema = z.object({ workId: z.uuid(), resultId: z.uuid(),
  source: newsLocalizationCandidateSchema, sourceHash: hash, inputHash: hash,
  policyVersion: z.string().min(1).max(120), promptVersion: z.string().min(1).max(120),
  backendId: z.string().min(1).max(120), modelFamily: z.string().min(1).max(120), modelId: z.string().min(1).max(200),
  contractHash: hash, promptHash: hash, responseHash: hash, outcome: z.unknown(),
}).strict();
export type NewsLocalizationCompletion = Readonly<z.infer<typeof newsLocalizationCompletionSchema>>;
export type NewsLocalizationDraft = Readonly<Omit<NewsLocalizationCompletion, "source" | "outcome"> & {
  newsItemId: number; locale: "ko"; sourceSnapshot: NewsLocalizationSource; status: "draft" | "needs_review";
  title: string | null; summary: string | null; facts: NewsLocalizationOutcome["state"] | null;
  validation: NewsLocalizationValidation;
}>;
export type NewsLocalizationApplyDependencies<Tx> = {
  readAssistControl(task: "news", tx: Tx): Promise<NewsLocalizationControl>;
  /** common consumer가 result를 저장한 바로 그 TX에서 원문 행을 잠근다. */
  loadSource(tx: Tx, newsItemId: number): Promise<NewsLocalizationSource | null>;
  saveDraft(tx: Tx, draft: NewsLocalizationDraft): Promise<{ created: boolean }>;
};

/** same-TX domain hook. 통과한 결과도 사람이 검토할 초안으로만 저장한다. */
export async function recordNewsLocalizationCompletion<Tx>(tx: Tx, value: unknown,
  dependencies: NewsLocalizationApplyDependencies<Tx>, options: { enabled?: boolean } = {}):
  Promise<{ state: "disabled" | "invalid_completion" | "obsolete" | "hidden" }
    | { state: "stored"; status: "draft" | "needs_review"; created: boolean }> {
  if (!(options.enabled ?? newsLocalizationBackendEnabled())) return { state: "disabled" };
  const parsed = newsLocalizationCompletionSchema.safeParse(value);
  if (!parsed.success) return { state: "invalid_completion" };
  const completion = parsed.data, snapshot = completion.source.news;
  if (completion.policyVersion !== NEWS_LOCALIZATION_POLICY_VERSION || completion.promptVersion !== ASSIST_PROMPT_VERSION
    || completion.sourceHash !== newsLocalizationSourceHash(snapshot)
    || completion.inputHash !== assistInputHash(buildNewsLocalizationInput(snapshot))) return { state: "obsolete" };
  const control = await dependencies.readAssistControl("news", tx);
  if (control.mode === "off" || !control.dispatchEnabled) return { state: "disabled" };
  const loaded = await dependencies.loadSource(tx, snapshot.id);
  if (!loaded) return { state: "obsolete" };
  const current = newsLocalizationSourceSchema.parse(loaded);
  if (current.state === "hidden") return { state: "hidden" };
  if (current.id !== snapshot.id || newsLocalizationSourceHash(current) !== completion.sourceHash) return { state: "obsolete" };
  const validation = validateNewsLocalization(current, completion.outcome, completion.sourceHash);
  const outcome = assistOutcomeSchemas.news.safeParse(completion.outcome), status = validation.ok ? "draft" : "needs_review";
  const stored = await dependencies.saveDraft(tx, { workId: completion.workId, resultId: completion.resultId,
    sourceHash: completion.sourceHash, inputHash: completion.inputHash, policyVersion: completion.policyVersion,
    promptVersion: completion.promptVersion, backendId: completion.backendId, modelFamily: completion.modelFamily,
    modelId: completion.modelId, contractHash: completion.contractHash, promptHash: completion.promptHash, responseHash: completion.responseHash,
    newsItemId: current.id, locale: "ko", sourceSnapshot: current,
    status, title: outcome.success ? outcome.data.state.draft.title : null,
    summary: outcome.success ? outcome.data.state.draft.summary : null,
    facts: outcome.success ? outcome.data.state : null, validation });
  return { state: "stored", status, created: stored.created };
}

/** 제품 결정 전 조회는 항상 공식 원문으로 돌아간다. draft를 공개 상태로 승격하는 API는 없다. */
export function originalNewsLocalizationFallback(source: Pick<NewsLocalizationSource, "title" | "summary">) {
  return { title: source.title, summary: source.summary, language: "original" as const };
}

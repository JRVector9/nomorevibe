import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, assistInputHash } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { buildNewsLocalizationInput, NEWS_LOCALIZATION_POLICY_VERSION, newsLocalizationSourceHash,
  type NewsLocalizationOutcome, type NewsLocalizationSource } from "@/lib/news/localization-contract";
import { enqueueNewsLocalizationDemand, newsLocalizationBackendEnabled, originalNewsLocalizationFallback,
  recordNewsLocalizationCompletion, type NewsLocalizationCompletion, type NewsLocalizationControl,
  type NewsLocalizationDraft, type NewsLocalizationQueuedWork } from "@/lib/news/localization-work";

const source: NewsLocalizationSource = { id: 7, url: "https://example.com/atlas", title: "Acme releases Atlas in public beta.",
  summary: "Acme released Atlas in public beta. General availability has not been announced.",
  revision: "2026-10-23 01:02:03.123456", observedAt: "2026-10-23 01:02:00.123456", state: "approved" };
function outcome(): NewsLocalizationOutcome {
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "news", state: { names: [{ original: "Acme", korean: null }], prices: [],
    quantities: [], dates: [], release: { stage: "beta", availability: "available", scope: [] }, qualifications: [],
    draft: { title: "Acme, Atlas 공개 베타 출시", summary: "Acme는 Atlas를 공개 베타로 출시했으며 정식 출시 일정은 미정이다." } },
  evidence_quality: { status: "sufficient", limitations: ["none"] },
  evidence: [{ source_id: buildNewsLocalizationInput(source).sources[0].sourceId, quote: source.title, supports: ["/state/release/stage"] }],
  action: { proposal: "publish_translation_candidate", reason_ko: "원문 사실을 보존한 초안입니다.", missing_items: [] } };
}
function completion(): NewsLocalizationCompletion {
  return { workId: "7bb1da60-66bb-4b08-85f1-2c3ff3a4dd3c", resultId: "d01c6391-d9b4-492c-92af-e95572d95136",
    source: { kind: "news", locale: "ko", news: source }, sourceHash: newsLocalizationSourceHash(source),
    inputHash: assistInputHash(buildNewsLocalizationInput(source)), policyVersion: NEWS_LOCALIZATION_POLICY_VERSION,
    promptVersion: ASSIST_PROMPT_VERSION, backendId: "m1-qwen", modelFamily: "qwen", modelId: "local-qwen",
    contractHash: "a".repeat(64), promptHash: "b".repeat(64), responseHash: "c".repeat(64), outcome: outcome() };
}
function harness() {
  const tx = { marker: "consumer-result-tx" }, queued = new Map<string, NewsLocalizationQueuedWork>(), drafts = new Map<string, NewsLocalizationDraft>();
  let current: NewsLocalizationSource | null = { ...source }, reads = 0;
  let control: NewsLocalizationControl = { mode: "shadow", dispatchEnabled: true, applyEnabled: false, revision: 4 };
  const dependencies = {
    readAssistControl: async (task: "news", sameTx: typeof tx) => { expect(task).toBe("news"); expect(sameTx).toBe(tx); return control; },
    loadSource: async (sameTx: typeof tx, id: number) => { expect(sameTx).toBe(tx); expect(id).toBe(source.id); reads += 1; return current; },
    enqueueWork: async (sameTx: typeof tx, work: NewsLocalizationQueuedWork) => {
      expect(sameTx).toBe(tx);
      const key = `${work.newsItemId}:${work.sourceHash}`, created = !queued.has(key);
      queued.set(key, queued.get(key) ?? work);
      return { workId: key, created };
    },
    saveDraft: async (sameTx: typeof tx, draft: NewsLocalizationDraft) => {
      expect(sameTx).toBe(tx);
      const created = !drafts.has(draft.resultId);
      drafts.set(draft.resultId, drafts.get(draft.resultId) ?? draft);
      return { created };
    },
  };
  return { tx, queued, drafts, dependencies, reads: () => reads,
    setSource(value: NewsLocalizationSource | null) { current = value; },
    setControl(value: Partial<NewsLocalizationControl>) { control = { ...control, ...value }; } };
}

describe("dormant news-localization work", () => {
  it("defaults off and retains the original fallback without calling storage", async () => {
    const h = harness();
    expect(newsLocalizationBackendEnabled({})).toBe(false);
    expect(newsLocalizationBackendEnabled({ NEWS_LOCALIZATION_BACKEND_ENABLED: "1" })).toBe(false);
    expect(newsLocalizationBackendEnabled({ NEWS_LOCALIZATION_BACKEND_ENABLED: "true" })).toBe(true);
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: false })).toEqual({ state: "disabled" });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: false })).toEqual({ state: "disabled" });
    expect(h.reads()).toBe(0);
    expect(h.queued.size + h.drafts.size).toBe(0);
    expect(originalNewsLocalizationFallback(source)).toEqual({ title: source.title, summary: source.summary, language: "original" });
  });
  it("honors both the task mode and dispatch control before reading a source", async () => {
    const h = harness();
    h.setControl({ mode: "off" });
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true })).toEqual({ state: "disabled" });
    h.setControl({ mode: "shadow", dispatchEnabled: false });
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true })).toEqual({ state: "disabled" });
    expect(h.reads()).toBe(0);
  });
  it("deduplicates locale demand while preserving source state and raw revisions", async () => {
    const h = harness();
    const first = await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true });
    const again = await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true });
    expect(first).toMatchObject({ state: "queued", created: true });
    expect(again).toMatchObject({ state: "queued", created: false });
    expect(h.queued.size).toBe(1);
    expect([...h.queued.values()][0]).toMatchObject({ task: "news", newsItemId: 7, originJob: "news-refresh", controlRevision: 4,
      policyVersion: NEWS_LOCALIZATION_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
      source: { kind: "news", locale: "ko", news: { revision: source.revision, state: "approved" } } });
    h.setSource({ ...source, revision: "2026-10-23 01:02:03.123457" });
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true })).toMatchObject({ state: "queued", created: true });
    expect(h.queued.size).toBe(2);
  });
  it("never revives a hidden source and permits pending drafts without approval", async () => {
    const h = harness();
    h.setSource({ ...source, state: "hidden" });
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true })).toEqual({ state: "hidden" });
    expect(h.queued.size).toBe(0);
    h.setSource({ ...source, state: "pending" });
    expect(await enqueueNewsLocalizationDemand(h.tx, source.id, h.dependencies, { enabled: true })).toMatchObject({ state: "queued" });
    expect([...h.queued.values()][0].source.news.state).toBe("pending");
  });
  it("stores a verified result as a draft in the caller's transaction", async () => {
    const h = harness();
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "stored", status: "draft", created: true });
    const draft = [...h.drafts.values()][0];
    expect(draft).toMatchObject({ status: "draft", sourceHash: completion().sourceHash, sourceSnapshot: source,
      backendId: "m1-qwen", modelFamily: "qwen", modelId: "local-qwen",
      validation: { ok: true, authority: "translation_candidate_only", semanticCoverage: "bounded_patterns" } });
    expect(draft).not.toHaveProperty("approved");
    expect(originalNewsLocalizationFallback(source).title).toBe(source.title);
  });
  it("keeps semantic failures as human needs_review without changing the original", async () => {
    const h = harness(), result = outcome();
    const value = { ...completion(), outcome: { ...result, state: { ...result.state,
      draft: { title: "Acme, Atlas 정식 출시", summary: "Acme는 Atlas를 정식 출시했다." } } } };
    expect(await recordNewsLocalizationCompletion(h.tx, value, h.dependencies, { enabled: true })).toEqual({ state: "stored", status: "needs_review", created: true });
    expect([...h.drafts.values()][0].validation.ok).toBe(false);
    expect(source.state).toBe("approved");
    expect(source.title).toBe("Acme releases Atlas in public beta.");
  });
  it("rejects obsolete policy, prompt, source and input bindings before applying", async () => {
    const h = harness();
    for (const changed of [{ policyVersion: "old" }, { promptVersion: "old" }, { sourceHash: "d".repeat(64) }, { inputHash: "d".repeat(64) }]) {
      expect(await recordNewsLocalizationCompletion(h.tx, { ...completion(), ...changed }, h.dependencies, { enabled: true })).toEqual({ state: "obsolete" });
    }
    expect(h.reads()).toBe(0);
    expect(h.drafts.size).toBe(0);
  });
  it("rejects changed, removed and hidden sources at completion time", async () => {
    const h = harness();
    h.setSource({ ...source, revision: "2026-10-23 01:02:03.123457" });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "obsolete" });
    h.setSource({ ...source, state: "hidden" });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "hidden" });
    h.setSource(null);
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "obsolete" });
    expect(h.drafts.size).toBe(0);
  });
  it("stops draft storage when task controls were turned off in flight", async () => {
    const h = harness();
    h.setControl({ mode: "off" });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "disabled" });
    h.setControl({ mode: "shadow", dispatchEnabled: false });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toEqual({ state: "disabled" });
    expect(h.reads()).toBe(0);
    expect(h.drafts.size).toBe(0);
  });
  it("makes repeated terminal delivery idempotent", async () => {
    const h = harness();
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toMatchObject({ state: "stored", created: true });
    expect(await recordNewsLocalizationCompletion(h.tx, completion(), h.dependencies, { enabled: true })).toMatchObject({ state: "stored", created: false });
    expect(h.drafts.size).toBe(1);
  });
  it("rejects an invalid completion or an injected approval field", async () => {
    const h = harness();
    for (const value of [{ ...completion(), resultId: "wrong" }, { ...completion(), approved: true }, { ...completion(), source: { ...completion().source, locale: "en" } }]) {
      expect(await recordNewsLocalizationCompletion(h.tx, value, h.dependencies, { enabled: true })).toEqual({ state: "invalid_completion" });
    }
    expect(h.reads()).toBe(0);
  });
});

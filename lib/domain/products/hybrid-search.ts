/**
 * 관련도순 검색 — 낱말 검색(FTS)과 의미 검색(bge-m3)을 섞고, 앞 30개를 재정렬 모델로 다시 줄 세운다.
 *
 * 2026-10-07 정답 60 질의(방식을 가린 채 채점을 보탬) nDCG@10: 낱말만 0.725 → 섞음 0.793 → 앞 30 재정렬 0.832.
 * 낱말 검색은 메이커가 쓴 말과 같은 말을 쳐야 걸리고("헬스 운동 기록" ↔ "workout log"), 의미 검색은 뜻이 가까운 것을
 * 찾지만 혼자서는 낱말 검색만 못했다(0.743). 둘을 순위로 섞으면(RRF) 서로의 빈 곳을 메운다. 재정렬 모델은 질의와
 * 제품 글을 한 쌍씩 함께 읽어 "유튜브 영상 요약" 같은 문장에서 자막 추출기보다 요약기를 앞에 둔다.
 *
 * 결과 집합은 낱말 검색에 걸린 것 전부 + 의미 검색만으로 걸린 것(코사인 0.5 이상, 최대 200)이다. 앞쪽(섞은 목록, 최대
 * 400)은 이 모듈이 줄 세우고, 그 뒤는 낱말 검색 순서 그대로 이어진다 — "더 보기"로 걸린 것 모두에 닿는다.
 *
 * 모델 서버(scripts/ops/search-models.sh)가 없거나 늦으면 그 단계만 빠진다: 임베딩이 없으면 낱말 검색 순서,
 * 재정렬이 없으면 섞은 순서. 검색이 실패하지는 않는다.
 */
import { embedTexts } from "./embedding";
import { readSearchModelJson, withinSearchModelDeadline } from "./search-model-http";
import { resolveSearchModelSettings } from "./search-model-settings";
import { logger } from "@/lib/observability/logger";

/** RRF 상수 — 흔히 쓰는 60. 순위만 보므로 두 점수의 단위가 달라도 섞인다 */
export const RRF_K = 60;
/** 갈래마다 섞는 깊이 */
export const CANDIDATES = 200;
/** 재정렬할 앞부분 — 20·30·50 이 비슷했고, 30쌍이 서버에서 약 0.3초다 */
export const RERANK_TOP = 30;
/**
 * 의미 검색만으로 걸린 것의 하한(코사인). 0.5 면 품질은 그대로(nDCG 0.831)이고 질의당 덧붙는 것이 163→68건,
 * "asdfgh"·"블라블라" 같은 말에는 아무것도 붙지 않는다. 0.55 는 맞는 것까지 빼서 0.814 로 떨어졌다.
 */
export const MIN_SIMILARITY = 0.5;
/** 검색어 하나 임베딩 — M3 안에서 10ms 안쪽, mini 에서 네트워크를 더해도 수십 ms */
const EMBED_TIMEOUT_MS = 500;
/** 재정렬 30쌍 — 평소 0.3초, 붐비면 0.5초 남짓. 넘기면 섞은 순서로 낸다 */
const RERANK_TIMEOUT_MS = 1_500;

type ModelWork = {
  embeddingCalls: number;
  rerankCalls: number;
  embeddingTimedOut: boolean;
  rerankTimedOut: boolean;
  fallback: boolean;
};

function searchModelWork(): ModelWork {
  return { embeddingCalls: 0, rerankCalls: 0, embeddingTimedOut: false, rerankTimedOut: false, fallback: false };
}

async function trackModelCall<T>(
  work: ModelWork, phase: "embedding" | "rerank", deadline: AbortSignal,
  load: (onRequest: () => void) => Promise<T>, override?: () => Promise<T>,
): Promise<T> {
  deadline.throwIfAborted();
  let requested = false;
  const onRequest = () => {
    requested = true;
    work[`${phase}Calls`]++;
  };
  try {
    if (override) onRequest();
    return await withinSearchModelDeadline(override ? override() : load(onRequest), deadline);
  } catch (error) {
    work[`${phase}TimedOut`] ||= requested && deadline.aborted;
    throw error;
  }
}

export type RankedSearch = {
  /** 앞쪽 — 섞고 재정렬한 순서(낱말 검색 앞 200 + 의미 검색만으로 걸린 것) */
  head: string[];
  /** 결과 전체 수 = 낱말 검색 수 + 의미 검색만으로 걸린 것 중 낱말 검색에도 없는 것 */
  total: number;
  /** 무엇이 실제로 돌았나 — 검색 기록과 점검에 남긴다 */
  semantic: boolean;
  reranked: boolean;
  modelWork?: ModelWork;
};

export type RankDependencies = {
  /** 낱말 검색 순서(관련도순) 앞 limit 개 */
  ftsSlugs: (limit: number) => Promise<string[]>;
  /** 낱말 검색에 걸린 수 */
  ftsCount: () => Promise<number>;
  /** 주어진 것 중 낱말 검색에도 걸리는 것 — 앞 200 밖에서 겹치는 것을 두 번 세지 않으려고 */
  ftsMatching: (slugs: string[]) => Promise<string[]>;
  /** 벡터와 가까운 순서(같은 거르기, 하한 이상) */
  nearestSlugs: (vector: number[], limit: number, minSimilarity: number) => Promise<string[]>;
  /** 재정렬 모델이 읽을 제품 글(EMBEDDING_DOCUMENT) */
  documents: (slugs: string[]) => Promise<Map<string, string>>;
  embed?: (text: string) => Promise<number[]>;
  rerank?: (query: string, documents: string[]) => Promise<number[]>;
};

/** 순위를 섞는다 — 각 목록에서 r 위면 1/(k + r) 를 더한다. 같은 점수는 앞 목록 순서를 따른다 */
export function fuseRanks(lists: readonly (readonly string[])[], k = RRF_K): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((slug, index) => score.set(slug, (score.get(slug) ?? 0) + 1 / (k + index + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}

async function resultCount(head: string[], fts: string[], ftsTotal: number, deps: RankDependencies): Promise<number> {
  const ftsSet = new Set(fts);
  const extra = head.filter((slug) => !ftsSet.has(slug));
  // Semantic matches and the preserved leader can also appear past the first 200 lexical results.
  const alsoMatching = fts.length < CANDIDATES || extra.length === 0 ? [] : await deps.ftsMatching(extra);
  return ftsTotal + extra.length - alsoMatching.length;
}

function scoredHead(top: string[], scores: number[]) {
  return top.map((slug, index) => ({ slug, score: scores[index], index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

export async function rankSearch(query: string, deps: RankDependencies): Promise<RankedSearch> {
  const { embed, rerank } = deps;
  const modelWork = searchModelWork();
  const embeddingDeadline = AbortSignal.timeout(EMBED_TIMEOUT_MS);
  // 임베딩 서버든 벡터 조회든(복제본에 pgvector 가 없을 때 등) 실패하면 낱말 검색만으로 간다
  const vectorLoad = trackModelCall(modelWork, "embedding", embeddingDeadline,
    (onRequest) => embedQuery(query, embeddingDeadline, onRequest), embed && (() => embed(query)))
    .then((vector) => deps.nearestSlugs(vector, CANDIDATES, MIN_SIMILARITY))
    .catch((error: unknown) => { logger.warn("search.semantic_unavailable", { error }); return null; });
  const [fts, ftsTotal, nearest] = await Promise.all([deps.ftsSlugs(CANDIDATES), deps.ftsCount(), vectorLoad]);

  const fused = nearest ? fuseRanks([fts, nearest]) : fts;
  const total = await resultCount(fused, fts, ftsTotal, deps);
  const semantic = nearest !== null;
  modelWork.fallback = !semantic;
  if (fused.length === 0) return { head: [], total, semantic, reranked: false, modelWork };

  // 임베딩 서버가 쉬어도 재정렬은 낱말 검색 순서에 그대로 건다
  const top = fused.slice(0, RERANK_TOP);
  try {
    const texts = await deps.documents(top);
    const inputs = top.map((slug) => texts.get(slug) ?? slug);
    const deadline = AbortSignal.timeout(RERANK_TIMEOUT_MS);
    const scores = await trackModelCall(modelWork, "rerank", deadline,
      (onRequest) => rerankDocuments(query, inputs, { signal: deadline, onRequest }),
      rerank && (() => rerank(query, inputs)));
    const order = scoredHead(top, scores).map((row) => row.slug);
    return { head: [...order, ...fused.slice(RERANK_TOP)], total, semantic, reranked: true, modelWork };
  } catch (error) {
    logger.warn("search.rerank_unavailable", { error });
    modelWork.fallback = true;
    return { head: fused, total, semantic, reranked: false, modelWork };
  }
}

/**
 * Rank the expanded search and independently find the original search's best result.
 * The two model calls within each phase share a deadline. Database document reads are shared.
 */
export async function rankMultilingualSearch(
  raw: string, translated: string, deps: RankDependencies, nativeFtsSlugs: RankDependencies["ftsSlugs"],
): Promise<RankedSearch> {
  const { embed, rerank } = deps;
  const modelWork = searchModelWork();
  const embeddingDeadline = AbortSignal.timeout(EMBED_TIMEOUT_MS);
  let nearestTimedOut = false;
  const nearest = async (query: string): Promise<string[] | null> => {
    try {
      const vector = await trackModelCall(modelWork, "embedding", embeddingDeadline,
        (onRequest) => embedQuery(query, embeddingDeadline, onRequest), embed && (() => embed(query)));
      embeddingDeadline.throwIfAborted();
      return await withinSearchModelDeadline(deps.nearestSlugs(vector, CANDIDATES, MIN_SIMILARITY), embeddingDeadline);
    } catch {
      nearestTimedOut ||= embeddingDeadline.aborted;
      return null;
    }
  };

  const [fts, ftsTotal, nativeFts, rawNearest, translatedNearest] = await Promise.all([
    deps.ftsSlugs(CANDIDATES),
    deps.ftsCount(),
    nativeFtsSlugs(CANDIDATES).catch(() => null),
    nearest(raw),
    nearest(translated),
  ]);
  const lexical = rawNearest ? fuseRanks([fts, rawNearest]) : fts;
  const expanded = rawNearest !== null && translatedNearest !== null && nativeFts !== null;
  const bilingual = expanded ? fuseRanks([fts, rawNearest, translatedNearest]) : lexical;
  const native = expanded ? fuseRanks([nativeFts, rawNearest]) : [];

  let head = bilingual;
  let reranked = false;
  const fallback = () => {
    head = lexical;
    modelWork.fallback = true;
  };
  if (!expanded) fallback();

  if (!nearestTimedOut && (head.length > 0 || native.length > 0)) {
    const rerankDeadline = AbortSignal.timeout(RERANK_TIMEOUT_MS);
    const searchTop = head.slice(0, RERANK_TOP);
    const nativeTop = native.slice(0, RERANK_TOP);
    try {
      const docs = await withinSearchModelDeadline(deps.documents([...new Set([...searchTop, ...nativeTop])]), rerankDeadline);
      const rerankSlugs = async (query: string, slugs: string[]): Promise<number[] | null> => {
        if (!slugs.length) return [];
        try {
          const inputs = slugs.map((slug) => docs.get(slug) ?? slug);
          const scores = await trackModelCall(modelWork, "rerank", rerankDeadline,
            (onRequest) => rerankDocuments(query, inputs, { signal: rerankDeadline, onRequest }),
            rerank && (() => rerank(query, inputs)));
          return scores.length === slugs.length && scores.every(Number.isFinite) ? scores : null;
        } catch {
          return null;
        }
      };
      const [scores, nativeScores] = await Promise.all([
        rerankSlugs(expanded ? `${raw} / ${translated}` : raw, searchTop),
        rerankSlugs(raw, nativeTop),
      ]);
      if (scores && nativeScores && !rerankDeadline.aborted) {
        head = [...scoredHead(searchTop, scores).map((row) => row.slug), ...head.slice(RERANK_TOP)];
        const leader = scoredHead(nativeTop, nativeScores)[0];
        const preserveLeader = leader && leader.score >= 0;
        if (preserveLeader) head = [leader.slug, ...head.filter((slug) => slug !== leader.slug)];
        reranked = searchTop.length > 0 || Boolean(preserveLeader);
      } else {
        fallback();
        // Reuse original scores when they cover the lexical top 30 after a non-timeout failure.
        const originalScores = nativeScores && new Map(nativeTop.map((slug, index) => [slug, nativeScores[index]]));
        const lexicalTop = lexical.slice(0, RERANK_TOP);
        if (!rerankDeadline.aborted && originalScores && lexicalTop.every((slug) => originalScores.has(slug))) {
          head = [...scoredHead(lexicalTop, lexicalTop.map((slug) => originalScores.get(slug)!)).map((row) => row.slug),
            ...lexical.slice(RERANK_TOP)];
          reranked = true;
        }
      }
    } catch {
      fallback();
    }
  }

  return { head, total: await resultCount(head, fts, ftsTotal, deps), semantic: rawNearest !== null, reranked, modelWork };
}

async function embedQuery(query: string, signal: AbortSignal, onRequest: () => void): Promise<number[]> {
  const [vector] = await embedTexts([query], { timeoutMs: EMBED_TIMEOUT_MS, signal, onRequest });
  return vector;
}

/** 재정렬 서버(llama-server --reranking)의 점수 — 글 순서대로 */
export async function rerankDocuments(
  query: string,
  documents: readonly string[],
  options: { url?: string; timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; onRequest?: () => void } = {},
): Promise<number[]> {
  const timeout = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? RERANK_TIMEOUT_MS);
  const explicit = options.url !== undefined;
  let settings: Awaited<ReturnType<typeof resolveSearchModelSettings>> | null = null;
  if (!explicit) {
    try { settings = await withinSearchModelDeadline(resolveSearchModelSettings("search-rerank"), timeout); }
    catch (error) {
      throw new Error(error instanceof Error && /^search_model_/.test(error.message) ? error.message : "rerank_settings_unavailable", { cause: error });
    }
  }
  const base = explicit ? (options.url ?? "").trim().replace(/\/+$/, "") : settings!.baseUrl;
  if (!base) throw new Error("rerank_no_url");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const payload: { query: string; documents: readonly string[]; top_n: number; model?: string } = {
    query, documents, top_n: documents.length,
  };
  const configured = !explicit && settings?.source === "configured";
  if (configured && settings) {
    if (settings.model) payload.model = settings.model;
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  }
  timeout.throwIfAborted();
  options.onRequest?.();
  const response = await (options.fetchImpl ?? fetch)(`${base}/v1/rerank`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: timeout,
    ...(configured ? { redirect: "error" as const } : {}),
  });
  if (!response.ok) throw new Error(`rerank_http_${response.status}`);
  const body = await withinSearchModelDeadline(readSearchModelJson(response, 1024 * 1024), timeout).catch(() => null) as { results?: { index: number; relevance_score: number }[] } | null;
  const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY);
  for (const row of body?.results ?? []) {
    if (Number.isInteger(row.index) && row.index >= 0 && row.index < documents.length && Number.isFinite(row.relevance_score)) {
      scores[row.index] = row.relevance_score;
    }
  }
  if (scores.some((score) => score === Number.NEGATIVE_INFINITY)) throw new Error("rerank_bad_response");
  return scores;
}

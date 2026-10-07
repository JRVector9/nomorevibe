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

export type RankedSearch = {
  /** 앞쪽 — 섞고 재정렬한 순서(낱말 검색 앞 200 + 의미 검색만으로 걸린 것) */
  head: string[];
  /** 결과 전체 수 = 낱말 검색 수 + 의미 검색만으로 걸린 것 중 낱말 검색에도 없는 것 */
  total: number;
  /** 무엇이 실제로 돌았나 — 검색 기록과 점검에 남긴다 */
  semantic: boolean;
  reranked: boolean;
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

export async function rankSearch(query: string, deps: RankDependencies): Promise<RankedSearch> {
  const embed = deps.embed ?? embedQuery;
  const rerank = deps.rerank ?? rerankDocuments;
  // 임베딩 서버든 벡터 조회든(복제본에 pgvector 가 없을 때 등) 실패하면 낱말 검색만으로 간다
  const vectorLoad = embed(query)
    .then((vector) => deps.nearestSlugs(vector, CANDIDATES, MIN_SIMILARITY))
    .catch((error: unknown) => { logger.warn("search.semantic_unavailable", { error }); return null; });
  const [fts, ftsTotal, nearest] = await Promise.all([deps.ftsSlugs(CANDIDATES), deps.ftsCount(), vectorLoad]);

  const ftsSet = new Set(fts);
  const vectorOnly = (nearest ?? []).filter((slug) => !ftsSet.has(slug));
  // 앞 200 밖에서 낱말 검색에도 걸린 것 — 이미 앞쪽에 있으니 전체 수에서 한 번만 센다
  const alsoMatching = fts.length < CANDIDATES || vectorOnly.length === 0 ? [] : await deps.ftsMatching(vectorOnly);
  const fused = nearest ? fuseRanks([fts, nearest]) : fts;
  const total = ftsTotal + vectorOnly.length - alsoMatching.length;
  const semantic = nearest !== null;
  if (fused.length === 0) return { head: [], total, semantic, reranked: false };

  // 임베딩 서버가 쉬어도 재정렬은 낱말 검색 순서에 그대로 건다
  const top = fused.slice(0, RERANK_TOP);
  try {
    const texts = await deps.documents(top);
    const scores = await rerank(query, top.map((slug) => texts.get(slug) ?? slug));
    const order = top.map((slug, index) => ({ slug, score: scores[index], index }))
      .sort((a, b) => b.score - a.score || a.index - b.index).map((row) => row.slug);
    return { head: [...order, ...fused.slice(RERANK_TOP)], total, semantic, reranked: true };
  } catch (error) {
    logger.warn("search.rerank_unavailable", { error });
    return { head: fused, total, semantic, reranked: false };
  }
}

async function embedQuery(query: string): Promise<number[]> {
  const [vector] = await embedTexts([query], { timeoutMs: EMBED_TIMEOUT_MS });
  return vector;
}

/** 재정렬 서버(llama-server --reranking)의 점수 — 글 순서대로 */
export async function rerankDocuments(
  query: string,
  documents: readonly string[],
  options: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number[]> {
  const base = (options.url ?? process.env.RERANK_URL)?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("rerank_no_url");
  const response = await (options.fetchImpl ?? fetch)(`${base}/v1/rerank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, documents, top_n: documents.length }),
    signal: AbortSignal.timeout(options.timeoutMs ?? RERANK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`rerank_http_${response.status}`);
  const body = await response.json() as { results?: { index: number; relevance_score: number }[] };
  const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY);
  for (const row of body.results ?? []) {
    if (Number.isInteger(row.index) && row.index >= 0 && row.index < documents.length && Number.isFinite(row.relevance_score)) {
      scores[row.index] = row.relevance_score;
    }
  }
  if (scores.some((score) => score === Number.NEGATIVE_INFINITY)) throw new Error("rerank_bad_response");
  return scores;
}

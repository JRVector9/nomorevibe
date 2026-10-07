/**
 * 의미 검색의 임베딩 — 제품 글과 검색어를 bge-m3 벡터(1024)로 바꾼다.
 *
 * 모델은 서버 Mac 의 llama.cpp llama-server 가 돌린다(scripts/ops/search-models.sh, EMBEDDING_URL). Ollama 와 같은
 * GGUF 파일이라 2026-10-07 실험의 벡터와 같다(코사인 1.0). 제품 벡터와 검색어 벡터는 반드시 같은 모델이어야 해서,
 * 모델 파일이 바뀌면 EMBEDDING_MODEL 을 바꾸고 잡이 전부 다시 임베딩한다.
 */
import { sql } from "drizzle-orm";
import { products } from "@/lib/db/schema";

/** 모델 파일 이름과 sha256 앞 8자리 — 저장한 벡터가 어느 모델 것인지 */
export const EMBEDDING_MODEL = "bge-m3-f16@daec91ff";
export const EMBEDDING_DIMENSIONS = 1024;
/** 안전장치 — 공개분에서 가장 긴 글이 1,191자(500토큰)이고 서버는 한 글에 2,048토큰까지 받는다 */
const DOCUMENT_CHARS = 2_000;

/**
 * 임베딩할 글 — 이름·소개·설명(소개와 같으면 뺀다)·토픽·카테고리·키워드를 줄바꿈으로 잇는다.
 * 본문·README 는 넣지 않는다. 앞 800자씩 넣어 보니 섞은 검색이 오히려 나빠졌다(설치 명령·코드 같은 잡음).
 * 재정렬도 같은 글을 본다 — 키워드를 빼면 재정렬 nDCG 가 0.825 → 0.759 로 떨어졌다(키워드가 한·영을 잇는다).
 */
export const EMBEDDING_DOCUMENT = sql<string>`left(concat_ws(E'\n',
  nullif(btrim(${products.name}), ''),
  nullif(btrim(${products.tagline}), ''),
  nullif(btrim(case when ${products.description} = ${products.tagline} then '' else ${products.description} end), ''),
  nullif(btrim(coalesce(${products.searchTopics}, '')), ''),
  nullif(btrim(coalesce(${products.searchCategory}, '')), ''),
  nullif(btrim(coalesce(${products.searchKeywords}, '')), '')), ${DOCUMENT_CHARS})`;

export class EmbeddingUnavailableError extends Error {}

/** halfvec 리터럴 — '[0.1,0.2,...]' */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * 글 여럿을 한 번에 임베딩한다. 서버가 없거나(EMBEDDING_URL 없음) 늦거나 이상한 답을 하면 EmbeddingUnavailableError —
 * 검색은 낱말 검색만으로, 잡은 다음 틱으로 넘어간다.
 */
export async function embedTexts(
  texts: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; url?: string; fetchImpl?: typeof fetch },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const base = (options.url ?? process.env.EMBEDDING_URL)?.trim().replace(/\/+$/, "");
  if (!base) throw new EmbeddingUnavailableError("no_url");
  const timeout = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new EmbeddingUnavailableError(timeout.aborted ? "timeout" : "network", { cause: error });
  }
  if (!response.ok) throw new EmbeddingUnavailableError(`http_${response.status}`);
  const body = await response.json().catch(() => null) as { data?: { index: number; embedding: number[] }[] } | null;
  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new EmbeddingUnavailableError("bad_response");
  const vectors = [...rows].sort((a, b) => a.index - b.index).map((row) => row.embedding);
  if (vectors.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite))) {
    throw new EmbeddingUnavailableError("bad_vector");
  }
  return vectors;
}

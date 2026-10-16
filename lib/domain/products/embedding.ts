/**
 * 의미 검색의 임베딩 — 제품 글과 검색어를 bge-m3 벡터(1024)로 바꾼다.
 *
 * 모델은 서버 Mac 의 llama.cpp llama-server 가 돌린다(scripts/ops/search-models.sh, EMBEDDING_URL). Ollama 와 같은
 * GGUF 파일이라 2026-10-07 실험의 벡터와 같다(코사인 1.0). 제품 벡터와 검색어 벡터는 반드시 같은 모델이어야 해서,
 * 모델 파일이 바뀌면 EMBEDDING_MODEL 을 바꾸고 잡이 전부 다시 임베딩한다.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { products } from "@/lib/db/schema";

/** 모델 파일 이름과 sha256 앞 8자리 — 저장한 벡터가 어느 모델 것인지 */
export const EMBEDDING_MODEL = "bge-m3-f16@daec91ff";
/** 모델 파일 전체 sha256(scripts/ops/search-models.sh EMBED_SHA) — 대체 서버가 같은 revision 인지 이것으로 맞춘다 */
export const EMBEDDING_MODEL_SHA256 = "daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c";
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

/**
 * 같은 벡터 공간이 되려면 같아야 하는 전처리 — 제품 글(위 SQL 그대로), 검색어는 접두어 없이 원문(relevance.ts raw),
 * CLS 풀링(평균 풀링은 같은 모델이라도 코사인 0.75, 2026-10-07 실측), halfvec 코사인 거리. 글 SQL 이 바뀌면 해시도 바뀐다.
 */
export function embeddingPreprocessingHash(document: { sql: string; params: unknown[] }): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, document: { sql: document.sql, params: document.params },
    query: "raw", pooling: "cls", distance: "halfvec-cosine" })).digest("hex");
}
export const EMBEDDING_PREPROCESSING_HASH = embeddingPreprocessingHash(new PgDialect().sqlToQuery(EMBEDDING_DOCUMENT));
/**
 * 확인 표본 기준(PR16 제안값, root 결정 대상) — 저장 벡터와 같은 글을 대체 서버로 임베딩해 잰 최소 코사인.
 * 같은 GGUF 는 엔진이 달라도 1.0 이었고(Ollama↔llama-server), 풀링이 틀리면 0.75 였다. halfvec 반올림 오차는 이보다 훨씬 작다.
 */
export const EMBEDDING_PARITY_MIN_SAMPLES = 32;
export const EMBEDDING_PARITY_MIN_COSINE = 0.999;

/** 대체 임베딩 서버(비상 운영)를 운영자가 확인해 적은 기록 — EMBEDDING_SERVING_PROFILE(JSON) */
const servingProfileSchema = z.strictObject({
  version: z.literal(1), model: z.string().min(1).max(120), modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  dimensions: z.number().int().positive().max(65_536), preprocessingHash: z.string().regex(/^[0-9a-f]{64}$/),
  parity: z.strictObject({ samples: z.number().int().min(0).max(1_000_000), minCosine: z.number().min(-1).max(1) }),
});
export type EmbeddingDegradedReason = "profile_missing" | "profile_invalid" | "endpoint_missing" | "model_mismatch"
  | "revision_mismatch" | "dimensions_mismatch" | "preprocessing_mismatch" | "parity_unverified";
export type EmbeddingReadiness = { mode: "legacy" } | { mode: "semantic" } | { mode: "degraded"; reasons: EmbeddingDegradedReason[] };

/** 기록 하나를 지금 코드의 기준과 맞춘다. 다른 것마다 이유를 남긴다 — 하나라도 있으면 벡터를 섞지 않는다 */
export function classifyEmbeddingProfile(raw: string): Exclude<EmbeddingReadiness, { mode: "legacy" }> {
  if (raw.trim() === "") return { mode: "degraded", reasons: ["profile_missing"] };
  let parsed: z.infer<typeof servingProfileSchema>;
  try {
    if (Buffer.byteLength(raw, "utf8") > 4096) throw new Error();
    parsed = servingProfileSchema.parse(JSON.parse(raw));
  } catch { return { mode: "degraded", reasons: ["profile_invalid"] }; }
  const reasons: EmbeddingDegradedReason[] = [];
  if (parsed.model !== EMBEDDING_MODEL) reasons.push("model_mismatch");
  if (parsed.modelSha256 !== EMBEDDING_MODEL_SHA256) reasons.push("revision_mismatch");
  if (parsed.dimensions !== EMBEDDING_DIMENSIONS) reasons.push("dimensions_mismatch");
  if (parsed.preprocessingHash !== EMBEDDING_PREPROCESSING_HASH) reasons.push("preprocessing_mismatch");
  if (parsed.parity.samples < EMBEDDING_PARITY_MIN_SAMPLES || parsed.parity.minCosine < EMBEDDING_PARITY_MIN_COSINE) reasons.push("parity_unverified");
  return reasons.length ? { mode: "degraded", reasons } : { mode: "semantic" };
}

/** 기본 비활성 — 변수가 아예 없으면 legacy(지금 동작 그대로). 빈 값이라도 있으면 기록과 서버 주소를 검사한다 */
export function embeddingReadiness(env: Readonly<Record<string, string | undefined>> = process.env,
  url: string | undefined = env.EMBEDDING_URL): EmbeddingReadiness {
  const raw = env.EMBEDDING_SERVING_PROFILE;
  if (raw === undefined) return { mode: "legacy" };
  const checked = classifyEmbeddingProfile(raw);
  if (url?.trim()) return checked;
  return { mode: "degraded", reasons: [...(checked.mode === "degraded" ? checked.reasons : []), "endpoint_missing"] };
}

/** 확인 표본: 대체 서버의 새 벡터와 저장 벡터(같은 text_hash) 쌍의 최소 코사인. 차원이 다르거나 영·NaN 벡터는 -1 */
export function embeddingParity(pairs: readonly { observed: readonly number[]; stored: readonly number[] }[]): { samples: number; minCosine: number } {
  let minCosine = pairs.length ? 1 : -1;
  for (const { observed, stored } of pairs) {
    let dot = 0, a = 0, b = 0;
    if (observed.length === EMBEDDING_DIMENSIONS && stored.length === EMBEDDING_DIMENSIONS) {
      for (let k = 0; k < EMBEDDING_DIMENSIONS; k++) { dot += observed[k] * stored[k]; a += observed[k] ** 2; b += stored[k] ** 2; }
    }
    const cosine = dot / Math.sqrt(a * b);
    minCosine = Math.min(minCosine, Number.isFinite(cosine) ? cosine : -1);
  }
  return { samples: pairs.length, minCosine };
}

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
  // 같은 공간이 확인되지 않은 서버는 부르지 않는다 — 검색은 낱말만, 벡터 잡은 쓰지 않고 다음 틱으로
  const readiness = embeddingReadiness(process.env, base);
  if (readiness.mode === "degraded") throw new EmbeddingUnavailableError(`degraded:${readiness.reasons.join(",")}`);
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

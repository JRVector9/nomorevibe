import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  classifyEmbeddingProfile, embeddingParity, embeddingPreprocessingHash, embeddingReadiness, embedTexts, EMBEDDING_DIMENSIONS,
  EMBEDDING_DOCUMENT, EMBEDDING_MODEL, EMBEDDING_MODEL_SHA256, EMBEDDING_PARITY_MIN_COSINE, EMBEDDING_PARITY_MIN_SAMPLES,
  EMBEDDING_PREPROCESSING_HASH, EmbeddingUnavailableError,
} from "@/lib/domain/products/embedding";
import { rankSearch } from "@/lib/domain/products/hybrid-search";
import { modelServerHealth } from "@/lib/operations/model-servers";

/**
 * 비상 운영(PR16)의 임베딩 동일성 — 대체 서버가 저장된 벡터와 같은 공간(같은 모델 파일·1024차원·같은 글/풀링)임을
 * 운영자가 확인해 적은 기록이 있어야만 의미 검색을 쓴다. 아니면 이유를 붙여 degraded, 검색은 낱말만, 벡터는 쓰지 않는다.
 * 기록 환경변수가 아예 없으면(M3·mini 지금 설정) 동작이 그대로다.
 */
const profile = (patch: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, model: EMBEDDING_MODEL, modelSha256: EMBEDDING_MODEL_SHA256, dimensions: EMBEDDING_DIMENSIONS,
  preprocessingHash: EMBEDDING_PREPROCESSING_HASH,
  parity: { samples: EMBEDDING_PARITY_MIN_SAMPLES, minCosine: EMBEDDING_PARITY_MIN_COSINE }, ...patch,
});
const unit = (index: number, scale = 1) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, k) => (k === index ? scale : 0));
const vectorReply = () => vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: unit(0) }] }), { status: 200 }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("임베딩 동일성 기준", () => {
  it("모델 이름 끝 8자리는 고정한 모델 파일 sha256 의 앞자리다", () => {
    expect(EMBEDDING_MODEL).toBe(`bge-m3-f16@${EMBEDDING_MODEL_SHA256.slice(0, 8)}`);
    expect(EMBEDDING_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("전처리 해시는 지금 제품 글 SQL 에서 나오고, 글이 바뀌면 달라진다", () => {
    const current = new PgDialect().sqlToQuery(EMBEDDING_DOCUMENT);
    expect(embeddingPreprocessingHash(current)).toBe(EMBEDDING_PREPROCESSING_HASH);
    expect(embeddingPreprocessingHash({ ...current, params: [1_000] })).not.toBe(EMBEDDING_PREPROCESSING_HASH);
    expect(embeddingPreprocessingHash({ ...current, sql: current.sql.replace("search_keywords", "search_topics") }))
      .not.toBe(EMBEDDING_PREPROCESSING_HASH);
  });
});

describe("대체 임베딩 서버 기록 판정", () => {
  it("모델·revision·차원·전처리·확인 표본이 모두 같아야 의미 검색이다", () => {
    expect(classifyEmbeddingProfile(profile())).toEqual({ mode: "semantic" });
  });

  it("다른 것마다 정확한 이유를 붙여 degraded 로 둔다", () => {
    const degraded = (...reasons: string[]) => ({ mode: "degraded", reasons });
    expect(classifyEmbeddingProfile(profile({ model: "bge-m3-q8@0123abcd" }))).toEqual(degraded("model_mismatch"));
    expect(classifyEmbeddingProfile(profile({ modelSha256: "0".repeat(64) }))).toEqual(degraded("revision_mismatch"));
    expect(classifyEmbeddingProfile(profile({ dimensions: 768 }))).toEqual(degraded("dimensions_mismatch"));
    expect(classifyEmbeddingProfile(profile({ preprocessingHash: "f".repeat(64) }))).toEqual(degraded("preprocessing_mismatch"));
    expect(classifyEmbeddingProfile(profile({ parity: { samples: EMBEDDING_PARITY_MIN_SAMPLES - 1, minCosine: 1 } })))
      .toEqual(degraded("parity_unverified"));
    // 2026-10-07 실측: 같은 모델이라도 평균 풀링이면 코사인 0.75 — 다른 공간이다
    expect(classifyEmbeddingProfile(profile({ parity: { samples: EMBEDDING_PARITY_MIN_SAMPLES, minCosine: 0.75 } })))
      .toEqual(degraded("parity_unverified"));
    expect(classifyEmbeddingProfile(profile({ model: "x@00000000", modelSha256: "0".repeat(64), dimensions: 768,
      preprocessingHash: "f".repeat(64), parity: { samples: 0, minCosine: -1 } })))
      .toEqual(degraded("model_mismatch", "revision_mismatch", "dimensions_mismatch", "preprocessing_mismatch", "parity_unverified"));
  });

  it("비었거나 읽을 수 없는 기록은 확인 안 된 것이다", () => {
    expect(classifyEmbeddingProfile("")).toEqual({ mode: "degraded", reasons: ["profile_missing"] });
    expect(classifyEmbeddingProfile("  ")).toEqual({ mode: "degraded", reasons: ["profile_missing"] });
    for (const raw of ["{", "null", JSON.stringify({ version: 2 }), profile({ extra: true }), profile() + " ".repeat(5_000)]) {
      expect(classifyEmbeddingProfile(raw)).toEqual({ mode: "degraded", reasons: ["profile_invalid"] });
    }
  });

  it("기록 변수가 없으면 지금 그대로(legacy), 있으면 서버 주소까지 본다", () => {
    expect(embeddingReadiness({ EMBEDDING_URL: "http://m3:18081" })).toEqual({ mode: "legacy" });
    expect(embeddingReadiness({})).toEqual({ mode: "legacy" });
    expect(embeddingReadiness({ EMBEDDING_SERVING_PROFILE: profile(), EMBEDDING_URL: "http://oracle:18081" })).toEqual({ mode: "semantic" });
    expect(embeddingReadiness({ EMBEDDING_SERVING_PROFILE: profile() })).toEqual({ mode: "degraded", reasons: ["endpoint_missing"] });
    expect(embeddingReadiness({ EMBEDDING_SERVING_PROFILE: "", EMBEDDING_URL: " " }))
      .toEqual({ mode: "degraded", reasons: ["profile_missing", "endpoint_missing"] });
    expect(embeddingReadiness({ EMBEDDING_SERVING_PROFILE: profile() }, "http://explicit:18081")).toEqual({ mode: "semantic" });
  });
});

describe("확인 표본 비교", () => {
  it("같은 글의 새 벡터와 저장 벡터 사이 최소 코사인을 잰다(크기는 상관없다)", () => {
    expect(embeddingParity([{ observed: unit(0), stored: unit(0) }, { observed: unit(1, 3), stored: unit(1) }]))
      .toEqual({ samples: 2, minCosine: 1 });
    expect(embeddingParity([{ observed: unit(0), stored: unit(0) }, { observed: unit(2), stored: unit(3) }]))
      .toEqual({ samples: 2, minCosine: 0 });
  });

  it("표본이 없거나 차원이 다르거나 영벡터·NaN 이면 확인 실패다", () => {
    expect(embeddingParity([])).toEqual({ samples: 0, minCosine: -1 });
    expect(embeddingParity([{ observed: [1, 0, 0], stored: [1, 0, 0] }])).toEqual({ samples: 1, minCosine: -1 });
    expect(embeddingParity([{ observed: unit(0, 0), stored: unit(0) }])).toEqual({ samples: 1, minCosine: -1 });
    expect(embeddingParity([{ observed: unit(0, Number.NaN), stored: unit(0) }])).toEqual({ samples: 1, minCosine: -1 });
  });
});

describe("degraded 면 서버를 부르지 않는다", () => {
  it("embedTexts 는 부르기 전에 이유를 붙여 쓸 수 없다고 알린다 — 잡은 벡터를 쓰지 않는다", async () => {
    vi.stubEnv("EMBEDDING_SERVING_PROFILE", profile({ dimensions: 768 }));
    const fetchImpl = vi.fn();
    await expect(embedTexts(["글"], { timeoutMs: 1_000, url: "http://oracle:18081", fetchImpl }))
      .rejects.toThrow(new EmbeddingUnavailableError("degraded:dimensions_mismatch"));
    vi.stubEnv("EMBEDDING_SERVING_PROFILE", "");
    vi.stubEnv("EMBEDDING_URL", undefined);
    await expect(embedTexts(["글"], { timeoutMs: 1_000, fetchImpl }))
      .rejects.toThrow(new EmbeddingUnavailableError("degraded:profile_missing,endpoint_missing"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("legacy 와 semantic 은 지금처럼 서버를 부른다", async () => {
    vi.stubEnv("EMBEDDING_SERVING_PROFILE", undefined);
    const legacy = vectorReply();
    expect(await embedTexts(["글"], { timeoutMs: 1_000, url: "http://m3:18081", fetchImpl: legacy })).toHaveLength(1);
    expect(legacy).toHaveBeenCalledTimes(1);
    vi.stubEnv("EMBEDDING_SERVING_PROFILE", profile());
    const semantic = vectorReply();
    expect(await embedTexts(["글"], { timeoutMs: 1_000, url: "http://oracle:18081", fetchImpl: semantic })).toHaveLength(1);
    expect(semantic).toHaveBeenCalledTimes(1);
  });

  it("검색은 벡터 조회 없이 낱말 검색 순서로 낸다", async () => {
    vi.stubEnv("EMBEDDING_SERVING_PROFILE", profile({ modelSha256: "0".repeat(64) }));
    vi.stubEnv("EMBEDDING_URL", "http://oracle:18081");
    vi.stubEnv("RERANK_URL", undefined);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const nearestSlugs = vi.fn(async () => ["vector-only"]);
    const result = await rankSearch("메모 앱", {
      ftsSlugs: async () => ["a", "b"], ftsCount: async () => 2, ftsMatching: async () => [], nearestSlugs,
      documents: async () => new Map(),
    });
    expect(result).toEqual({ head: ["a", "b"], total: 2, semantic: false, reranked: false });
    expect(nearestSlugs).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("운영센터는 degraded 이유를 그대로 보이고 임베딩 서버는 묻지 않는다", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => { asked.push(url); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await modelServerHealth({ EMBEDDING_SERVING_PROFILE: profile({ modelSha256: "0".repeat(64) }),
      EMBEDDING_URL: "http://oracle:18081", RERANK_URL: "http://rerank:2" }, fetchImpl)).toEqual([
      { name: "임베딩", ok: false, error: "degraded(revision_mismatch)" },
      { name: "재정렬", ok: true },
    ]);
    expect(asked).toEqual(["http://rerank:2/health"]);
    expect(await modelServerHealth({ EMBEDDING_SERVING_PROFILE: "" }, fetchImpl))
      .toEqual([{ name: "임베딩", ok: false, error: "degraded(profile_missing,endpoint_missing)" }]);
    expect(await modelServerHealth({ EMBEDDING_SERVING_PROFILE: profile(), EMBEDDING_URL: "http://oracle:18081" }, fetchImpl))
      .toEqual([{ name: "임베딩", ok: true }]);
    expect(asked).toEqual(["http://rerank:2/health", "http://oracle:18081/health"]);
  });
});

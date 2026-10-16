/**
 * 검색 모델 서버(임베딩·재정렬) 응답 확인 — 운영센터가 그릴 때마다 /health 를 한 번씩 묻는다.
 *
 * 서버가 죽어도 검색은 FTS 로 조용히 넘어가고(hybrid-search.ts), 임베딩 잡도 로그 경고만 남겨 화면 어디에도
 * 나오지 않았다. 웹 컨테이너에 주소가 없으면(설정 안 함) 묻지 않는다.
 */
import { embeddingReadiness } from "@/lib/domain/products/embedding";

export type ModelServerHealth = { name: "임베딩" | "재정렬"; ok: boolean; error?: string };

const TIMEOUT_MS = 1_500;

async function probe(name: ModelServerHealth["name"], url: string | undefined, fetchImpl: typeof fetch): Promise<ModelServerHealth | null> {
  const base = url?.trim().replace(/\/+$/, "");
  if (!base) return null;
  try {
    const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return response.ok ? { name, ok: true } : { name, ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "응답 없음" : "연결 실패" };
  }
}

export async function modelServerHealth(env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch): Promise<ModelServerHealth[]> {
  // 비상 운영 기록(EMBEDDING_SERVING_PROFILE)이 있는데 같은 공간이 확인되지 않았으면 서버 응답 대신 그 이유를 보인다
  const readiness = embeddingReadiness(env);
  const embedding = readiness.mode === "degraded"
    ? Promise.resolve<ModelServerHealth>({ name: "임베딩", ok: false, error: `degraded(${readiness.reasons.join(",")})` })
    : probe("임베딩", env.EMBEDDING_URL, fetchImpl);
  const rows = await Promise.all([embedding, probe("재정렬", env.RERANK_URL, fetchImpl)]);
  return rows.filter((row): row is ModelServerHealth => row !== null);
}

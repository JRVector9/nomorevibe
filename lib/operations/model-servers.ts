/**
 * 검색 모델 서버(임베딩·재정렬) 응답 확인 — 운영센터가 그릴 때마다 /health 를 한 번씩 묻는다.
 *
 * 서버가 죽어도 검색은 FTS 로 조용히 넘어가고(hybrid-search.ts), 임베딩 잡도 로그 경고만 남겨 화면 어디에도
 * 나오지 않았다. 웹 컨테이너에 주소가 없으면(설정 안 함) 묻지 않는다.
 */
import { embeddingReadiness } from '@/lib/domain/products/embedding';
import { readSearchModelJson, withinSearchModelDeadline } from '@/lib/domain/products/search-model-http';
import { resolveSearchModelSettings, type SearchModelTask } from '@/lib/domain/products/search-model-settings';
import { withReadOnlyAiTaskModels } from '@/lib/llm/ai-task-models-snapshot';

export type ModelServerHealth = { name: "임베딩" | "재정렬"; ok: boolean; error?: string;
  source?: "environment" | "configured"; model?: string | null; baseUrl?: string; probeKind?: "models" | "health" };

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

const MODELS_MAX_BYTES = 1_048_576;
const MODELS_MAX = 512;

const noTrailingSlash = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
};

function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? '응답 없음' : '연결 실패';
}

async function environmentHealth(name: ModelServerHealth['name'], fetchImpl: typeof fetch): Promise<ModelServerHealth | null> {
  if (name === '임베딩') {
    const readiness = embeddingReadiness(process.env);
    if (readiness.mode === 'degraded') return { name, ok: false, error: `degraded(${readiness.reasons.join(',')})` };
    return probe(name, process.env.EMBEDDING_URL, fetchImpl);
  }
  return probe(name, process.env.RERANK_URL, fetchImpl);
}

async function actualProbe(name: ModelServerHealth['name'], task: SearchModelTask, fetchImpl: typeof fetch): Promise<ModelServerHealth | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let settings;
  try {
    settings = await withinSearchModelDeadline(resolveSearchModelSettings(task), signal);
  } catch {
    return { name, ok: false, error: '설정 확인 실패' };
  }
  if (settings.source === 'environment') {
    try {
      return await withinSearchModelDeadline(environmentHealth(name, fetchImpl), signal);
    } catch {
      return { name, ok: false, error: '환경 확인 실패' };
    }
  }
  const baseUrl = noTrailingSlash(settings.baseUrl?.trim() ?? '');
  const model = settings.model;
  const meta = { source: 'configured' as const, model, baseUrl, probeKind: 'models' as const };
  if (!baseUrl || !model) return { name, ok: false, error: '모델 설정 미완료', ...meta };
  try {
    const response = await withinSearchModelDeadline(fetchImpl(`${baseUrl}/v1/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      signal, redirect: 'error', cache: 'no-store',
    }), signal);
    if (!response.ok) return { name, ok: false, error: `HTTP ${response.status}`, ...meta };
    const payload = await withinSearchModelDeadline(readSearchModelJson(response, MODELS_MAX_BYTES), signal);
    const data = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
    if (!data) return { name, ok: false, error: '모델 목록 형식 오류', ...meta };
    if (data.length > MODELS_MAX) return { name, ok: false, error: '모델 목록이 너무 큽니다', ...meta };
    const listed = data.some(entry => !!entry && typeof entry === 'object' && (entry as { id?: unknown }).id === model);
    return listed ? { name, ok: true, ...meta } : { name, ok: false, error: '선택한 모델이 목록에 없습니다', ...meta };
  } catch (error) {
    return { name, ok: false, error: safeError(error), ...meta };
  }
}

async function legacyModelServerHealth(env: Readonly<Record<string, string | undefined>>, fetchImpl: typeof fetch): Promise<ModelServerHealth[]> {
  const readiness = embeddingReadiness(env);
  const embedding = readiness.mode === 'degraded'
    ? Promise.resolve<ModelServerHealth>({ name: '임베딩', ok: false, error: `degraded(${readiness.reasons.join(',')})` })
    : probe('임베딩', env.EMBEDDING_URL, fetchImpl);
  const rows = await Promise.all([embedding, probe('재정렬', env.RERANK_URL, fetchImpl)]);
  return rows.filter((row): row is ModelServerHealth => row !== null);
}

export async function modelServerHealth(env?: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch = fetch): Promise<ModelServerHealth[]> {
  if (env) return legacyModelServerHealth(env, fetchImpl);
  try {
    return await withReadOnlyAiTaskModels(async () => {
      const rows = await Promise.all([
        actualProbe('임베딩', 'search-embedding', fetchImpl),
        actualProbe('재정렬', 'search-rerank', fetchImpl),
      ]);
      return rows.filter((row): row is ModelServerHealth => row !== null);
    });
  } catch {
    return [
      { name: '임베딩', ok: false, error: '설정 확인 실패' },
      { name: '재정렬', ok: false, error: '설정 확인 실패' },
    ];
  }
}

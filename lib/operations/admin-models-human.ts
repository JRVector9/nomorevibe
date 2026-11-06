import { withAdminStagePools } from '@/lib/llm/admin-model-pools';
import { deepseekReviewReady } from '@/lib/crawl/deepseek-review';
import { scopedModel, scopedModelBaseUrl, scopedModelDefinition } from '@/lib/llm/model-registry';
import { currentHumanModelSelection, readHumanModelSelection, type HumanModelSelection, type HumanModelTarget } from './human-model-source';

/** 사람 위임 모델 한 개의 자동 연결 확인(렌더 때) — 등록부 키·제공자와 /models 결과·소요. 한 화면이 probe:<provider>:<key> 관측으로 남긴다. */
export type HumanModelProbe = { key: string; provider: string; ready: boolean; ms: number };

async function probeTarget(target: HumanModelTarget): Promise<boolean> {
  try {
    return await withAdminStagePools({ 'human-review': [target.key] }, 'admin-models-readiness', () => {
      const definition = scopedModelDefinition('human-review');
      if (!definition || definition.key !== target.key || definition.provider !== target.provider) return false;
      if (scopedModel('human-review', target.wire) !== target.wire) return false;
      if (scopedModelBaseUrl('human-review', target.baseUrl, target.provider) !== target.baseUrl) return false;
      return deepseekReviewReady();
    });
  } catch { return false; }
}

/**
 * 실제 사람 위임 선택(배정 표 → 풀 → 등록부 기본값)을 먼저 새로 읽고, 고른 키마다 추론과 같은 범위 해석기로 /models 를 확인한다.
 * 출처를 읽지 못했으면 빈 배열 — 부르는 쪽이 기본 모델로 조용히 내려가지 않는다. 동결 선택이 있으면 다시 읽지 않는다.
 */
export async function configuredHumanModelsProbe(keys: readonly string[] = [], frozen?: HumanModelSelection): Promise<HumanModelProbe[]> {
  const selection = frozen ?? await readHumanModelSelection(keys).catch(() => null);
  if (!selection || selection.source === 'unknown' || !selection.effectiveKeys.length) return [];
  return Promise.all(selection.effectiveKeys.map(async key => {
    const started = Date.now();
    const target = selection.targets.find(row => row.key === key);
    const provider = target?.provider ?? selection.effectiveModels.find(model => model.key === key)?.provider ?? 'local-direct';
    const ready = target ? await probeTarget(target) : false;
    return { key, provider, ready, ms: Date.now() - started };
  }));
}

/** Validate every effective human-review delegate through the same scoped model/endpoint resolver as inference. */
export async function configuredHumanModelsReady(keys: readonly string[] = [], frozen?: HumanModelSelection): Promise<boolean> {
  const selection = frozen ?? await readHumanModelSelection(keys).catch(() => null);
  if (!selection || selection.source === 'unknown' || !selection.effectiveKeys.length) return false;
  try {
    const results = await Promise.all(selection.effectiveKeys.map(key => {
      const target = selection.targets.find(row => row.key === key);
      return target ? probeTarget(target) : Promise.resolve(false);
    }));
    return results.length > 0 && results.every(Boolean);
  } catch { return false; }
}

/** Operator label for the actual human-review delegate: table row, then pool, then registry default. Sync for existing callers. */
export function humanReviewModelDisplay(keys: readonly string[] = []): { modelLabel: string; modelLocation: string } {
  const selection = currentHumanModelSelection(keys);
  if (selection.source === 'unknown') return { modelLabel: '모델 확인 불가', modelLocation: '배정 표·사람 위임 설정을 읽지 못했습니다' };
  if (!selection.effectiveModels.length) return { modelLabel: '모델 없음', modelLocation: '사람 위임에 쓸 모델을 찾지 못했습니다' };
  if (selection.source === 'table') {
    const names = selection.effectiveModels.map(model => `${model.displayName} (${model.key})`).join(', ');
    const modelLabel = selection.effectiveModels.length === 1 ? selection.effectiveModels[0].displayName : '선택 모델';
    return { modelLabel, modelLocation: `사람 위임 배정 표 · ${names}` };
  }
  if (selection.source === 'pool') {
    const names = selection.effectiveModels.map(model => model.displayName).join(', ');
    const modelLabel = selection.effectiveModels.length === 1 ? selection.effectiveModels[0].displayName : '선택 모델';
    return { modelLabel, modelLocation: `사람 위임 검수 풀 · ${names}` };
  }
  const model = selection.effectiveModels[0];
  return { modelLabel: model.displayName, modelLocation: `${model.key} · ${model.model}` };
}

import type { AdminModelsObservation } from './admin-models-observation';
import { modelStageId, type ModelStageAssignment } from './admin-models-view';

/** 한 단계의 현재 설정 신원과 현재 활성 장부 행을 물리 장비 그룹 하나로 접은 행. */
export type StageCapacityGroup = {
  /** observation.groups[].groupId 와 같은 값이다. 서버 이름을 추측하지 않는다. */
  labelId: string;
  /** 이 단계에서 실제 전송 중인 수(dispatched). */
  runningForStage: number;
  /** 이 단계에서 아직 정리되지 않은 예약 수(reserved). */
  reservedForStage: number;
  /** 같은 장비 그룹 전체의 점유(다른 단계 포함). observation.groups 값을 그대로 쓴다. */
  sharedHeld: number | null;
  /** 같은 장비 그룹의 한도. 읽지 못했으면 null 이다. */
  limit: number | null;
};

export type StageCapacitySummary = {
  /** 운영 DB 실측 자체를 읽지 못했다. 이때 0건으로 간주하지 않는다. */
  unavailable: boolean;
  /** 설정된 정확한 제공자·모델 신원을 이 단계 장부에서 찾지 못했다. */
  unresolved: boolean;
  /** 서로 다른 장비 그룹만 한 번씩. */
  groups: StageCapacityGroup[];
  /** 모든 그룹 한도를 더한 값. 그룹이 없거나, 미해결이거나, 한도 하나라도 모르면 null. */
  limit: number | null;
};

type Identity = { provider: string; model: string };

const identityKey = (identity: Identity) => JSON.stringify([identity.provider, identity.model]);

/** PrototypeModels 의 단계 행 선택과 같은 규칙이다. */
const inStage = (stageId: string, routeId: string) => modelStageId(routeId) === stageId ||
  routeId === stageId || (stageId === 'publish-classify' && routeId.startsWith('classify'));

function currentIdentities(assignment?: ModelStageAssignment): Identity[] {
  const seen = new Set<string>(), identities: Identity[] = [];
  for (const model of assignment?.models ?? []) {
    if (!model.provider || !model.model || model.model === '미설정') continue;
    const key = identityKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push({ provider: model.provider, model: model.model });
  }
  return identities;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * 대표 단계의 용량 표시 요약.
 *
 * - 설정된 정확한 (provider, model) 행은 지표가 0이어도 포함한다(현재 설정의 한도).
 * - 설정과 무관해도 이 단계에서 지금 dispatched/reserved/waiting 인 행은 포함한다(실제 실행).
 * - 그 밖의 과거 전용 그룹은 분모에 넣지 않는다. 이름·별칭·서버는 추측하지 않는다.
 */
export function summarizeStageCapacity(stageId: string, observation: AdminModelsObservation,
  assignment?: ModelStageAssignment): StageCapacitySummary {
  const configured = currentIdentities(assignment);
  // 실측 불가와 설정 불일치를 섞지 않는다. 실측 불가에서는 그룹을 만들지 않는다.
  if (observation.error || !observation.observedAt) {
    return { unavailable: true, unresolved: false, groups: [], limit: null };
  }

  const required = new Set(configured.map(identityKey));
  const matched = new Set<string>();
  // Only today's verified policy can identify a configured model's device.
  // The same model may have moved groups; yesterday's ledger is not today's limit.
  const selectedGroups = new Set<string>();
  for (const route of observation.policyVerified ? observation.configuredRoutes ?? [] : []) {
    if (!inStage(stageId, route.routeId) || !required.has(identityKey(route))) continue;
    matched.add(identityKey(route));
    selectedGroups.add(route.groupId);
  }
  const stageRows = observation.rows.filter(row => inStage(stageId, row.routeId));
  for (const row of stageRows) {
    if (row.dispatched > 0 || row.reserved > 0 || row.waiting > 0) selectedGroups.add(row.groupId);
  }
  const unresolved = configured.some(identity => !matched.has(identityKey(identity)));
  const totals = new Map([...selectedGroups].map(groupId => [groupId, { running: 0, reserved: 0 }]));
  for (const row of stageRows) {
    const total = totals.get(row.groupId);
    if (!total) continue;
    total.running += row.dispatched;
    total.reserved += row.reserved;
  }

  const observedGroups = new Map(observation.groups.map(group => [group.groupId, group]));
  const groups = [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([labelId, total]): StageCapacityGroup => {
      const group = observedGroups.get(labelId);
      return { labelId, runningForStage: total.running, reservedForStage: total.reserved,
        sharedHeld: group ? finiteOrNull(group.held) : null,
        limit: group ? finiteOrNull(group.limit) : null };
    });

  // 한도가 하나라도 비어 있으면 합계를 만들지 않는다(누락을 0 으로 바꾸지 않는다).
  const limit = unresolved || !groups.length || groups.some(group => group.limit === null)
    ? null : groups.reduce((total, group) => total + (group.limit as number), 0);

  return { unavailable: false, unresolved, groups, limit };
}

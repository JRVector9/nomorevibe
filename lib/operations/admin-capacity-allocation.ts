import { db, onPrimary } from "@/lib/db";
import type { ModelCapacityRouteQuota } from "@/lib/llm/capacity-devices";
import { saveModelCapacityRouteQuotas } from "@/lib/llm/capacity-devices-repository";
import { logger } from "@/lib/observability/logger";
import { listAiConnections } from "./admin-ai-tasks-repository";
import { capacityDeviceIssueMessage } from "./admin-capacity-devices";
import { readAdminModelsObservation } from "./admin-models-repository";
import { allocationAreaLabel, buildCapacityAllocationView, compareRouteIds, routeQuotaText, type AllocationView, type RouteQuotasFormInput } from "./capacity-allocation-view";
import { DrWriterFencedError } from "./dr/epoch";
import { deviceLabels } from "./llm-ops-view";

/**
 * 「칸 배분」(/admin/models/allocation, step 3)의 읽기·저장·거절 문장. 서버에서만 import 한다(DB 를 읽고 쓴다).
 * 화면 모형은 순수 모듈(capacity-allocation-view)이 만들고, 여기서는 장부 관측(장비 상태 포함) 한 번과 연결 이름만 더 읽는다.
 * 저장은 step 2 의 saveModelCapacityRouteQuotas 한 번이다(그 안에서 fence → control FOR UPDATE → 장비 행 FOR UPDATE·CAS → 칸 수 검사 → 줄 교체 →
 * operations_audit 한 줄). 여기서는 감사 줄을 또 쓰지 않는다.
 */

/** 화면 한 번 그리기 — 장부 관측(같은 읽기 전용 스냅숏 안의 장비 상태·정책 경로·최근 1시간 정산)과 연결 이름. 연결을 못 읽으면 장비 id 만 보인다 */
export async function readCapacityAllocationView(): Promise<AllocationView> {
  const [observation, connections] = await Promise.all([readAdminModelsObservation({ throughput: false }), listAiConnections().catch(() => null)]);
  return buildCapacityAllocationView({ observation, labels: connections ? deviceLabels(connections, observation) : null });
}

export type SaveRouteQuotasResult = { ok: true; deviceId: string; version: number; changes: string[]; warnings: string[] } | { ok: false; issues: string[] };
/** 저장소가 행도 감사도 건드리지 않고 던진 거절 — 운영자 문장으로 돌려준다. 그 밖(DB 오류)은 던진다 */
const REFUSAL_PREFIXES = ["model_capacity_route_quota_invalid:", "model_capacity_route_quota_version_mismatch:"];
const REFUSAL_CODES = ["model_capacity_route_quota_device_unconfigured", "model_capacity_device_version_exhausted", "model_capacity_control_missing",
  "model_capacity_replay_unsupported"];
const isRefusal = (code: string) => REFUSAL_PREFIXES.some(prefix => code.startsWith(prefix)) || REFUSAL_CODES.includes(code);

/** 저장 전·후의 바뀐 줄(「카테고리 분류: 없음 → 보장 1 · 상한 2」, 「빈 칸 빌려 쓰기: 켬 → 끔」) */
export function routeQuotaChangeLines(before: { lendIdle: boolean; quotas: readonly ModelCapacityRouteQuota[] },
  after: { lendIdle: boolean; quotas: readonly ModelCapacityRouteQuota[] }): string[] {
  const lines: string[] = [];
  if (before.lendIdle !== after.lendIdle) lines.push(`빈 칸 빌려 쓰기: ${before.lendIdle ? "켬" : "끔"} → ${after.lendIdle ? "켬" : "끔"}`);
  const routes = [...new Set([...before.quotas, ...after.quotas].map(quota => quota.routeId))].sort(compareRouteIds);
  for (const routeId of routes) {
    const was = routeQuotaText(before.quotas.find(quota => quota.routeId === routeId)), now = routeQuotaText(after.quotas.find(quota => quota.routeId === routeId));
    if (was !== now) lines.push(`${allocationAreaLabel(routeId)}: ${was} → ${now}`);
  }
  return lines;
}

/**
 * 장비 한 대의 몫 저장 — 쓰기 TX 하나에서 saveModelCapacityRouteQuotas(tx, input, actor). 거절 코드는 그대로 돌려준다(문장은 routeQuotaIssueMessage).
 * 저장 즉시 다음 입장 판정부터 쓰인다 — 잡힌 칸은 그대로 끝나고 DRAIN 은 없다.
 */
export async function saveAdminRouteQuotas(input: RouteQuotasFormInput, actor: string): Promise<SaveRouteQuotasResult> {
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  try {
    const { before, after, warnings } = await onPrimary(() => db.transaction(tx => saveModelCapacityRouteQuotas(tx, input, actor)));
    const changes = routeQuotaChangeLines(before, { lendIdle: after.lendIdle ?? true, quotas: after.routeQuotas ?? [] });
    // 몫이 바뀌면 다음 입장부터 결과가 바뀐다 — 「왜 이때부터 달라졌지」를 되짚을 수 있게(감사 줄은 저장소가 남겼다)
    logger.info("model_capacity_route_quota.saved", { actor, deviceId: after.deviceId, version: after.version, lines: after.routeQuotas?.length ?? 0, warnings });
    return { ok: true, deviceId: after.deviceId, version: after.version, changes, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
    const code = error instanceof Error ? error.message : String(error);
    if (!isRefusal(code)) throw error;
    return { ok: false, issues: [code] };
  }
}

// ---------- 거절·경고 코드 → 한국어 ----------
const INVALID_MESSAGES: Record<string, string> = {
  "quotas:min_sum_exceeds_limit": "보장 칸 합계가 장비 칸 수를 넘습니다 — 보장을 줄이거나, 장비 한도에서 칸 수를 먼저 늘려 주세요.",
  "quotas:duplicate_route": "같은 작업 영역이 두 번 있습니다. 새로고침해주세요.",
  quotas: "작업 영역 몫은 장비 하나에 64줄까지입니다.",
  deviceId: "장비 이름을 읽지 못했습니다. 새로고침해주세요.",
  expectedVersion: "판 번호(version)를 읽지 못했습니다. 새로고침해주세요.",
  lendIdle: "빈 칸 빌려 쓰기 값을 읽지 못했습니다. 새로고침해주세요.",
  actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요.",
  root: "칸 배분 입력 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해주세요.",
};
/**
 * saveModelCapacityRouteQuotas·saveAdminRouteQuotas 의 코드 → 운영자 문장. `quotas` 는 보낸 줄(경로 순) — 거절 경로의 quotas.<i> 를 작업 영역 이름으로 바꾼다.
 * 모르는 코드는 장비 한도 화면의 문장(capacityDeviceIssueMessage: DR·재생 DB·제어 행·판 상한)으로, 그것도 모르면 그대로 보인다.
 */
export function routeQuotaIssueMessage(issue: string, quotas: readonly Pick<ModelCapacityRouteQuota, "routeId">[] = []): string {
  if (issue === "model_capacity_route_quota_device_unconfigured")
    return "이 장비는 장비 행이 없거나 꺼져 있어 칸을 나눌 수 없습니다 — 장비 한도에서 장비 행을 먼저 저장하거나 켜 주세요.";
  const mismatch = /^model_capacity_route_quota_version_mismatch:(.+)$/.exec(issue);
  if (mismatch) return `다른 곳(장비 한도·칸 배분)에서 이 장비를 먼저 저장했습니다(지금 판 ${mismatch[1]}). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.`;
  const prefix = "model_capacity_route_quota_invalid:";
  if (!issue.startsWith(prefix)) return capacityDeviceIssueMessage(issue);
  const detail = issue.slice(prefix.length);
  if (INVALID_MESSAGES[detail]) return INVALID_MESSAGES[detail];
  const line = /^quotas\.(\d+)\.(minSlots|maxSlots|routeId)(?::([a-z_]+))?$/.exec(detail);
  if (line) {
    const quota = quotas[Number(line[1])];
    const area = quota ? allocationAreaLabel(quota.routeId) : `${Number(line[1]) + 1}번째 줄`;
    const field = line[2] === "minSlots" ? "보장" : "상한";
    if (line[3] === "exceeds_limit") return `${area}: ${field} 칸이 장비 칸 수보다 많습니다 — 장비 칸 수 이하로 적어주세요.`;
    if (line[3] === "min_exceeds_max") return `${area}: 보장 칸이 상한 칸보다 많습니다 — 상한을 보장 이상으로 적거나 비워 두세요.`;
    if (line[2] === "routeId") return `${area}: 경로 이름이 1~120자가 아니거나 앞뒤 공백·제어 문자가 있습니다. 새로고침해주세요.`;
    return line[2] === "minSlots" ? `${area}: 보장 칸은 0~256 의 정수입니다.` : `${area}: 상한 칸은 0~256 의 정수이거나 비워 둡니다.`;
  }
  return `칸 배분이 검사를 통과하지 못했습니다: ${detail}`;
}

/** 저장은 했지만 알릴 것(saveModelCapacityRouteQuotas warnings) */
export function routeQuotaWarningMessage(warning: string): string {
  if (warning === "policy_unreadable") return "용량 정책을 읽지 못해 이 경로들이 이 장비로 오는지 확인하지 못했습니다 — 몫은 저장했습니다.";
  const unmapped = /^route_unmapped:(.+)$/.exec(warning);
  if (unmapped) return `${allocationAreaLabel(unmapped[1])}: 지금 정책에서 이 장비로 오지 않습니다 — 몫은 저장했고, 이 장비로 오면 그때부터 적용됩니다.`;
  return warning;
}

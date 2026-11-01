import { servingContractRowAccess, TEXT_ROUTE_BLOCK_DETAIL, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { PROBE_LIST_FAILED_MESSAGE, probeObservationKey, type ProbeObservation, type ProbeResultLike } from "./admin-models-probe";
import { probeIdentityOf, type ModelCard } from "./admin-models-view";

/**
 * 엔진 직접 연결 모델의 자동 연결 확인(2026-11-01) — /admin/models 의 「연결 확인」 열.
 *
 * 전에는 렌더 때 자동 확인이 사람 위임·카테고리 CLI·검색 서버뿐이라, 직접 연결 엔진(gpu3090 Qwen·M3 gpt-oss·M1 gemma·Supa)은 실제로
 * 일하고 있어도 「확인 기록 없음」으로 보였다. 이제 활성 계약(model_serving_contracts, 스냅숏은 enabled 행만) 중 transport direct 이거나
 * local-direct 계약(direct-openai-chat-v1, PR 3b-C)인 행의 엔진에 GET <endpoint>/models 한 번(생성 요청 없음)을 보내 그 슬롯의
 * probe:<provider>:<model> 관측에 자동(auto) 결과로 남긴다.
 * - 대상: 화면의 모델 카드(buildModelCards)마다 카드가 가진 계약 중 직접 행. 키는 표가 읽는 probeIdentityOf(card) 와 같다.
 *   열 수 있는 행(textRouteAccess 와 같은 규칙, servingContractRowAccess)이 없으면 호출하지 않고 그 이유(저장한 키를 열 수 없음 · 게이트웨이 인증)를
 *   기존 문구(TEXT_ROUTE_BLOCK_DETAIL)로만 남긴다. 게이트웨이 전송 행·계약 없는 카드는 대상이 아니다(「확인 기록 없음」 그대로).
 * - 중복 제거: 같은 슬롯 키는 한 번, 같은 /models 주소·같은 인증은 한 번만 부르고 결과를 나눠 쓴다.
 * - 간격: DIRECT_PROBE_INTERVAL_MS(1분). 그 슬롯의 저장된 관측이 수동이든 자동이든 1분 안이면 건너뛴다 — 수동 결과를 1분 안에 덮지 않는다.
 *   DB 를 못 읽을 때를 위해 프로세스 안의 마지막 시도 시각도 같은 간격으로 본다(30초 자동 새로고침·여러 탭이 엔진을 두드리지 않는다).
 * - 실행기: 계약 저장·「엔진 API」 이름 읽기와 같은 readbackServingEndpoint(5초 제한, 저장한 키는 Bearer 로만). 결과 문구는 수동 버튼과 같다.
 * - 관측 값에는 결과·소요 ms·provider·model·routeId·짧은 설명만 들어간다. 주소·호스트·키·헤더는 이 모듈 밖으로 나가지 않는다(로그도 남기지 않는다).
 */
export const DIRECT_PROBE_INTERVAL_MS = 60_000;
export const DIRECT_PROBE_DETAIL = "엔진 직접 연결 · GET /models";
export const DIRECT_PROBE_BLOCKED_DETAIL = "엔진 직접 연결 · 호출 안 함(계약 인증)";

export type DirectProbeTarget = Readonly<{
  key: string; identity: Readonly<{ routeId: string; provider: string; model: string }>;
  /** 엔진 목록에서 찾을 이름(계약 행의 model 과 계약 JSON 의 model) */
  names: readonly string[];
  /** 메모리 안에서만 쓴다 — 관측·로그에 넣지 않는다. 막힌 대상은 null. */
  endpoint: string | null; bearer: string | null;
  /** 호출하지 않는 이유(한국어 문구). null 이면 부른다. */
  blocked: string | null;
}>;
export type DirectProbeEntry = { identity: { routeId: string; provider: string; model: string }; result: ProbeResultLike; detail: string };
export type EndpointModelsReader = (endpoint: string, apiKey: string | null) =>
  Promise<{ ok: true; models: readonly { id: string }[] } | { ok: false; reason: string }>;
type CardLike = Pick<ModelCard, "id" | "name" | "definition" | "rows" | "requests" | "contracts">;

const field = (contract: unknown, name: string): string | null => {
  const value = contract && typeof contract === "object" ? (contract as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" && value ? value : null;
};
const directRow = (row: StoredServingContract) => row.transport === "direct" || field(row.contract, "provider") === "local-direct";

/** 카드 → 자동 확인 대상. 같은 슬롯 키는 한 번. 직접 행이 없거나 열 수 있는 행에 주소가 없으면 대상이 아니다. */
export function directProbeTargets(cards: readonly CardLike[], rows: readonly StoredServingContract[]): DirectProbeTarget[] {
  const targets = new Map<string, DirectProbeTarget>();
  for (const card of cards) {
    const identity = probeIdentityOf(card as ModelCard);
    if (!identity.provider || !identity.model) continue;
    const key = probeObservationKey(identity);
    if (targets.has(key)) continue;
    const mine = rows.filter(row => directRow(row) && card.contracts.some(link => link.routeId === row.routeId && link.model === row.model))
      .sort((a, b) => a.routeId.localeCompare(b.routeId) || a.model.localeCompare(b.model))
      .map(row => ({ row, access: servingContractRowAccess(row), endpoint: field(row.contract, "endpoint") }));
    if (!mine.length) continue;
    const open = mine.find(entry => entry.access.block === null && entry.endpoint);
    if (open) {
      targets.set(key, { key, identity: { routeId: open.row.routeId, ...identity }, endpoint: open.endpoint, bearer: open.access.bearer ?? null, blocked: null,
        names: [...new Set([open.row.model, field(open.row.contract, "model")].filter((name): name is string => !!name))] });
      continue;
    }
    const block = mine.find(entry => entry.access.block !== null)?.access.block;
    if (block) targets.set(key, { key, identity: { routeId: mine[0].row.routeId, ...identity }, names: [], endpoint: null, bearer: null, blocked: TEXT_ROUTE_BLOCK_DETAIL[block] });
  }
  return [...targets.values()];
}

/** 저장된 관측(수동·자동 모두)이 간격보다 오래됐거나 없으면 참. 시각을 못 읽으면 오래된 것으로 본다. */
export function directProbeDue(saved: Pick<ProbeObservation, "observedAt"> | undefined, now: number, interval = DIRECT_PROBE_INTERVAL_MS): boolean {
  if (!saved) return true;
  const at = Date.parse(saved.observedAt);
  return !Number.isFinite(at) || now - at >= interval;
}

const holder = globalThis as unknown as { __nmvDirectProbeGate?: Map<string, number> };
/** 프로세스 안의 슬롯별 마지막 시도 시각(ms). */
export function directProbeGate(): Map<string, number> { return holder.__nmvDirectProbeGate ??= new Map(); }

/** 지금 부를 대상만 고르고 시도 시각을 적는다 — 저장된 관측과 프로세스 안 시도 둘 다 간격 밖이어야 한다. */
export function claimDirectProbes(targets: readonly DirectProbeTarget[], saved: Readonly<Record<string, Pick<ProbeObservation, "observedAt">>>, now: number,
  gate: Map<string, number> = directProbeGate(), interval = DIRECT_PROBE_INTERVAL_MS): DirectProbeTarget[] {
  return targets.filter(target => {
    if (!directProbeDue(saved[target.key], now, interval)) return false;
    const last = gate.get(target.key);
    if (last !== undefined && now - last < interval) return false;
    gate.set(target.key, now);
    return true;
  });
}

/** 같은 엔진 목록을 한 번만 부르는 묶음 키(메모리 안에서만). readbackServingEndpoint 가 부르는 /models 주소와 같은 기준이다. */
function modelsUrl(endpoint: string): string {
  try { const url = new URL(endpoint); return `${url.origin}${url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "")}/models`; }
  catch { return endpoint; }
}

/** 대상마다 결과 한 건. 같은 /models·같은 인증은 한 번만 부르고, 막힌 대상은 부르지 않는다. 던지지 않는다. */
export async function runDirectProbes(targets: readonly DirectProbeTarget[], read: EndpointModelsReader, clock: () => number = Date.now): Promise<DirectProbeEntry[]> {
  const calls = new Map<string, Promise<{ outcome: Awaited<ReturnType<EndpointModelsReader>>; ms: number }>>();
  const bearers: (string | null)[] = [];
  return Promise.all(targets.map(async (target): Promise<DirectProbeEntry> => {
    if (target.blocked || !target.endpoint)
      return { identity: { ...target.identity }, result: { listed: null, error: target.blocked ?? PROBE_LIST_FAILED_MESSAGE }, detail: DIRECT_PROBE_BLOCKED_DETAIL };
    // 인증은 번호로만 묶는다 — 키 자체를 묶음 키에 넣지 않는다.
    let bearerIndex = bearers.indexOf(target.bearer);
    if (bearerIndex < 0) bearerIndex = bearers.push(target.bearer) - 1;
    const group = `${modelsUrl(target.endpoint)}#${bearerIndex}`;
    let call = calls.get(group);
    if (!call) {
      const started = clock();
      call = read(target.endpoint, target.bearer).catch(() => ({ ok: false as const, reason: "unreachable" }))
        .then(outcome => ({ outcome, ms: Math.max(0, clock() - started) }));
      calls.set(group, call);
    }
    const { outcome, ms } = await call;
    // 실행기의 이유 코드(http_401 · unreachable · endpoint_invalid)만 붙인다 — 모양이 다르면 주소·본문이 섞일 수 있어 버린다.
    const reason = !outcome.ok && /^[a-z0-9_:]{1,60}$/.test(outcome.reason) ? outcome.reason : "unreachable";
    if (!outcome.ok) return { identity: { ...target.identity }, result: { listed: null, listMs: ms, error: `${PROBE_LIST_FAILED_MESSAGE} · ${reason}` }, detail: DIRECT_PROBE_DETAIL };
    return { identity: { ...target.identity }, result: { listed: outcome.models.some(model => target.names.includes(model.id)), listMs: ms, error: null }, detail: DIRECT_PROBE_DETAIL };
  }));
}

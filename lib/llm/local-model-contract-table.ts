import { servingContractSnapshot } from "./serving-contract-store";
import { localModelServingContractSchema, localModelServingContractsSchema, resolveLocalModelServingContract,
  type LocalModelServingContract } from "./local-model-serving-contract";

/**
 * 관리 화면 계약 표(model_serving_contracts)에 둔 local-openai-chat-v1 계약(PR 3b-C) — 재배포 없이 엔진 직접 계약을 바꾼다.
 *
 * 행 모양: route_id = "local-model:<backendId>", model = 계약의 model, contract = 계약 그대로 + routeId(표의 identity CHECK 가
 * contract.routeId = route_id 를 요구한다). routeId 칸만 떼고 localModelServingContractSchema 로 검사하므로 hash(localModelContractHash)는
 * env(LOCAL_MODEL_SERVING_CONTRACTS)에 같은 계약을 둔 것과 같다.
 * - 표의 행은 운영자가 readback 으로 확인해 넣은 계약이다(게이트웨이 계약 행과 같은 규칙) — env 의 LOCAL_MODEL_VERIFIED_CONTRACT_HASHES 를
 *   따로 요구하지 않는다.
 * - 한 행이라도 모양이 틀리거나 행끼리 backend·endpoint 규칙(localModelServingContractsSchema)을 어기면 그 행들은 닫힌다 — env 로 되돌아가지
 *   않는다(같은 주소·모델의 표 행이 env 를 대신한다).
 * 스냅샷은 serving-contract-store 가 30초마다 다시 읽는다. MODEL_SERVING_CONTRACTS_DB=0 이면 표는 비어 있고 env 만 쓴다.
 */
export const LOCAL_MODEL_CONTRACT_ROUTE_PREFIX = "local-model:";
export const localModelContractRouteId = (backendId: string): string => `${LOCAL_MODEL_CONTRACT_ROUTE_PREFIX}${backendId}`;
export const LOCAL_MODEL_CONTRACT_PROTOCOL = "local-openai-chat-v1";

/** 표의 local 계약 한 행: 검사에 통과한 계약(contract) 또는 null, 그리고 짝짓기에 쓰는 원래 route_id·endpoint·model. */
export type TableLocalModelContract = Readonly<{ routeId: string; contract: LocalModelServingContract | null; endpoint: unknown; model: string }>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function tableLocalModelContracts(): readonly TableLocalModelContract[] {
  const rows = servingContractSnapshot().rows.flatMap(row => {
    if (!object(row.contract) || row.contract.protocol !== LOCAL_MODEL_CONTRACT_PROTOCOL) return [];
    const { routeId, ...value } = row.contract;
    const parsed = localModelServingContractSchema.safeParse(value);
    const contract = parsed.success && routeId === row.routeId && row.routeId === localModelContractRouteId(parsed.data.backendId)
      && parsed.data.model === row.model ? Object.freeze(parsed.data) : null;
    return [{ routeId: row.routeId, contract, endpoint: value.endpoint, model: row.model }];
  });
  // 행끼리의 규칙(같은 backend 두 번·한 endpoint 의 다른 장비 그룹)은 env 묶음과 같다 — 어기면 표의 계약을 모두 닫는다.
  const valid = rows.flatMap(row => row.contract ? [row.contract] : []);
  return localModelServingContractsSchema.safeParse(valid).success ? rows : rows.map(row => ({ ...row, contract: null }));
}

/** 표에서 이 주소·모델의 계약. 행이 없으면 undefined(=env 를 본다), 있지만 틀리거나 둘 이상이면 null(=닫음)이다. */
export function tableLocalModelContract(url: string, model: string): LocalModelServingContract | null | undefined {
  const matches = tableLocalModelContracts().filter(row => row.endpoint === url && row.model === model);
  if (!matches.length) return undefined;
  return matches.length === 1 ? matches[0].contract : null;
}

/**
 * backendId 로 계약 하나 — resolveLocalModelServingContract(env) 의 표 우선판(PR 3b-E, 3b-C 가 남긴 일 3).
 * 표에 그 backendId 의 행(`local-model:<backendId>`, 또는 그 backendId 를 적은 계약)이 있으면 표가 답이다: 하나이고 검사에 통과하면 그 계약,
 * 틀리거나 둘 이상이면 null(닫음 — env 로 되돌아가지 않는다). 표에 없을 때만 env `LOCAL_MODEL_SERVING_CONTRACTS` 를 예전과 똑같이 본다.
 * MODEL_SERVING_CONTRACTS_DB=0 이면 표가 비어 env 만 쓴다.
 */
export function resolveLocalModelContract(backendId: string, env: Readonly<Record<string, string | undefined>> = process.env): LocalModelServingContract | null {
  const routeId = localModelContractRouteId(backendId);
  const matches = tableLocalModelContracts().filter(row => row.routeId === routeId || row.contract?.backendId === backendId);
  if (!matches.length) return resolveLocalModelServingContract(backendId, env);
  return matches.length === 1 ? matches[0].contract : null;
}

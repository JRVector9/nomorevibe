"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { disableAdminServingContract, readbackServingEndpoint, saveAdminServingContract, type ServingContractAuthMode } from "@/lib/operations/admin-serving-contracts";
import { connectAdminEngine, engineBaseUrl, engineConnectAssignmentHref } from "@/lib/operations/admin-engine-connect";
import { disableAdminRegistryOverride, saveAdminRegistryOverride } from "@/lib/operations/admin-model-registry";

/** assignHref: 엔진 연결 뒤 「이 모델을 단계에 배정」 주소(모델 배정 화면의 새 배정 폼을 미리 채운다, PR 3b-D) */
export type ContractSaveState = { ok?: true; message?: string; issues?: string[]; assignHref?: string } | null;
const REASONS: Record<string, string> = {
  unknown_route: "모르는 경로입니다.", route_schema_unavailable: "이 경로의 계약 형식을 읽지 못했습니다.",
  contract_schema_invalid: "계약 JSON이 이 경로의 형식과 맞지 않습니다(필드·프로토콜·주소·한도를 확인해주세요).",
  serving_contract_key_required: "저장 키 방식에는 키가 필요합니다.", serving_contract_key_invalid: "키에 공백·제어 문자가 있습니다.",
  secret_box_key_missing: "서버에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없어 키를 저장할 수 없습니다.",
  serving_contract_input_invalid: "입력 값을 확인해주세요.", site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR).",
  engine_base_url_invalid: "주소는 https://호스트/v1 형태여야 합니다.", engine_routes_invalid: "쓰는 경로를 하나 이상 골라주세요.",
  registry_key_unknown: "등록부에 없는 모델입니다.", engine_connect_provider_unsupported: "abcllm 등록부 모델만 엔진 연결로 바꿀 수 있습니다.",
  engine_model_not_found: "엔진의 모델 목록에 그 모델이 없습니다. 「엔진 확인」으로 이름을 확인해주세요.",
  engine_max_len_unknown: "엔진의 /models 가 이 모델의 최대 길이(max_model_len)를 주지 않습니다. 「컨텍스트 상한(토큰)」에 모델의 컨텍스트 길이를 직접 넣어 주세요.",
  engine_max_len_invalid: "컨텍스트 상한은 1 이상 2,097,152 이하의 정수여야 합니다.",
  engine_probe_failed: "엔진에 1토큰 시험 호출을 보냈지만 정상 응답이 오지 않았습니다(모델 이름·키·엔진 상태를 확인해주세요).",
  engine_stage_save_failed: "연결은 저장했지만 단계 모델 지정은 실패했습니다. 고급 설정 › 단계별 모델 풀에서 직접 골라주세요.",
  model_definition_invalid: "등록부 정의 형식이 맞지 않습니다.", model_definition_duplicate: "같은 키가 두 번 있습니다.",
  model_registry_invalid: "합친 등록부가 검사를 통과하지 못했습니다(제한 시간 순서·키 중복 등).",
  model_purpose_duplicate: "한 용도(purpose)를 두 모델이 맡게 됩니다. 한 모델에만 두세요.",
  stage_pools_incompatible: "저장된 단계별 모델 선택과 맞지 않습니다(없는 키나 다른 어댑터). 단계 선택을 먼저 바꿔주세요.",
};
const reasonOf = (error: unknown) => error instanceof Error ? error.message : "";
const issue = (error: unknown) => {
  const reason = reasonOf(error);
  if (reason.startsWith("engine_unreachable:")) return [`엔진에 닿지 못했습니다(${reason.slice(19)}). 주소·키를 확인해주세요.`];
  const mismatch = /^engine_max_len_mismatch:(\d+):(\d+)$/.exec(reason);
  if (mismatch) return [`엔진이 알려 준 최대 길이(${mismatch[1]})와 입력한 컨텍스트 상한(${mismatch[2]})이 다릅니다. 엔진 값이 기준이니 입력을 비우거나 ${mismatch[1]}로 맞춰 주세요.`];
  return [REASONS[reason] ?? "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요."];
};

/** Save one route+model contract. The key field is write-only: empty keeps the stored key. */
export const saveServingContract = webWriteAction(async function saveServingContract(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const raw = String(form.get("contract") ?? "");
  let contract: unknown;
  try { if (raw.length > 16_000) throw new Error("too_long"); contract = JSON.parse(raw); } catch { return { issues: ["계약 JSON을 읽지 못했습니다."] }; }
  try {
    const result = await saveAdminServingContract({ routeId: String(form.get("routeId") ?? ""), contract,
      auth: String(form.get("auth") ?? "gateway") as ServingContractAuthMode, transport: form.get("transport") === "direct" ? "direct" : "gateway", apiKey: String(form.get("apiKey") ?? "") || undefined,
      note: String(form.get("note") ?? "") || null }, admin.login);
    revalidatePath("/admin/models/contracts");
    return { ok: true, message: `저장했습니다(#${result.id}, ${result.contractHash.slice(0, 12)}). 각 앱은 30초 안에 다음 작업부터 씁니다.` };
  } catch (error) { return { issues: issue(error) }; }
});

export const disableServingContract = webWriteAction(async function disableServingContract(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  try {
    const done = await disableAdminServingContract(String(form.get("routeId") ?? ""), String(form.get("model") ?? ""), admin.login);
    revalidatePath("/admin/models/contracts");
    return done ? { ok: true, message: "껐습니다. 같은 모델의 env 계약이 있으면 그것이 다시 쓰입니다." } : { issues: ["켜진 계약이 없습니다."] };
  } catch (error) { return { issues: issue(error) }; }
});

/** Read-only engine model list for filling a contract. Admin only; the key is not stored or returned. Gated like the model probe. */
export const readbackEngine = webWriteAction(async function readbackEngine(endpoint: string, apiKey: string):
  Promise<{ ok: true; models: { id: string; maxModelLen: number | null }[] } | { ok: false; reason: string }> {
  if (!await currentAdmin()) return { ok: false, reason: "unauthorized" };
  return readbackServingEndpoint(endpoint, apiKey.trim() || null);
});

/** One step: engine address + key + model → registry definition, direct contracts for the chosen routes, and (optionally) stage selection. */
export const connectEngine = webWriteAction(async function connectEngine(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  // The typed context bound: empty means none; digits only (the range is checked with the engine's answer in connectAdminEngine).
  const maxModelLen = String(form.get("maxModelLen") ?? "").trim();
  if (maxModelLen && !/^\d{1,7}$/.test(maxModelLen)) return { issues: [REASONS.engine_max_len_invalid] };
  const registryKey = String(form.get("registryKey") ?? ""), routes = form.getAll("routes").map(String);
  try {
    const result = await connectAdminEngine({ registryKey, baseUrl: String(form.get("baseUrl") ?? ""),
      auth: form.get("auth") === "none" ? "none" : "stored", apiKey: String(form.get("apiKey") ?? "") || undefined,
      engineModel: String(form.get("engineModel") ?? ""), routes, selectStages: form.get("selectStages") === "on",
      note: String(form.get("note") ?? "") || null, maxModelLen: maxModelLen ? Number(maxModelLen) : undefined }, admin.login);
    for (const path of ["/admin/models/contracts", "/admin/models"]) revalidatePath(path);
    const parts = [`연결했습니다: 경로 ${result.contracts.length}개(${result.contracts.map(row => row.routeId).join(", ")}), 요청 모델 ${result.requestModel}`
      + `(엔진 응답 이름 ${result.responseModel}), 토큰 한도 ${result.totalTokenBound}${result.totalTokenBoundFrom === "operator" ? "(운영자 입력)" : ""}.`,
      result.stages.length ? `단계 모델 지정: ${result.stages.join(", ")}.` : "단계 모델은 바꾸지 않았습니다.",
      ...(result.firstReviewRenamed ? ["1차 모델 선택을 새 이름으로 바꿨습니다."] : []),
      result.missingPolicyRoutes.length ? `용량 정책에 아직 없는 경로가 있어 그 호출은 보류됩니다: ${result.missingPolicyRoutes.join(" · ")} (정책 추가 필요).`
        : "용량 정책에 경로가 있습니다. 각 앱은 30초 안에 다음 작업부터 씁니다."];
    return { ok: true, message: parts.join(" "), assignHref: engineConnectAssignmentHref(registryKey, routes) };
  } catch (error) { return { issues: issue(error) }; }
});

/** Engine model list for the connect form (address in the https://host/v1 form). Admin only; the key is not stored or returned. */
export const readbackEngineBase = webWriteAction(async function readbackEngineBase(baseUrl: string, apiKey: string):
  Promise<{ ok: true; models: { id: string; maxModelLen: number | null }[] } | { ok: false; reason: string }> {
  if (!await currentAdmin()) return { ok: false, reason: "unauthorized" };
  const base = engineBaseUrl(baseUrl);
  return base ? readbackServingEndpoint(`${base}/chat/completions`, apiKey.trim() || null) : { ok: false, reason: "endpoint_invalid" };
});

export const saveRegistryOverride = webWriteAction(async function saveRegistryOverride(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const raw = String(form.get("definition") ?? "");
  let definition: unknown;
  try { if (raw.length > 16_000) throw new Error("too_long"); definition = JSON.parse(raw); } catch { return { issues: ["정의 JSON을 읽지 못했습니다."] }; }
  try {
    const result = await saveAdminRegistryOverride(definition, admin.login, String(form.get("note") ?? "") || null);
    for (const path of ["/admin/models/contracts", "/admin/models"]) revalidatePath(path);
    return { ok: true, message: `저장했습니다(#${result.id}). 각 앱은 30초 안에 다음 작업부터 씁니다.` };
  } catch (error) { return { issues: issue(error) }; }
});

export const disableRegistryOverride = webWriteAction(async function disableRegistryOverride(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  try {
    const done = await disableAdminRegistryOverride(String(form.get("key") ?? ""), admin.login);
    for (const path of ["/admin/models/contracts", "/admin/models"]) revalidatePath(path);
    return done ? { ok: true, message: "되돌렸습니다. 코드 기본 정의가 다시 쓰입니다." } : { issues: ["켜진 덮어쓰기가 없습니다."] };
  } catch (error) { return { issues: issue(error) }; }
});

"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { disableAdminServingContract, readbackServingEndpoint, saveAdminServingContract, type ServingContractAuthMode } from "@/lib/operations/admin-serving-contracts";

export type ContractSaveState = { ok?: true; message?: string; issues?: string[] } | null;
const REASONS: Record<string, string> = {
  unknown_route: "모르는 경로입니다.", route_schema_unavailable: "이 경로의 계약 형식을 읽지 못했습니다.",
  contract_schema_invalid: "계약 JSON이 이 경로의 형식과 맞지 않습니다(필드·프로토콜·주소·한도를 확인해주세요).",
  serving_contract_key_required: "저장 키 방식에는 키가 필요합니다.", serving_contract_key_invalid: "키에 공백·제어 문자가 있습니다.",
  secret_box_key_missing: "서버에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없어 키를 저장할 수 없습니다.",
};
const issue = (error: unknown) => [REASONS[error instanceof Error ? error.message : ""] ?? "저장하지 못했습니다. 새로고침해 현재 상태를 확인해주세요."];

/** Save one route+model contract. The key field is write-only: empty keeps the stored key. */
export const saveServingContract = webWriteAction(async function saveServingContract(_previous: ContractSaveState, form: FormData): Promise<ContractSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const raw = String(form.get("contract") ?? "");
  let contract: unknown;
  try { if (raw.length > 16_000) throw new Error("too_long"); contract = JSON.parse(raw); } catch { return { issues: ["계약 JSON을 읽지 못했습니다."] }; }
  try {
    const result = await saveAdminServingContract({ routeId: String(form.get("routeId") ?? ""), contract,
      auth: String(form.get("auth") ?? "gateway") as ServingContractAuthMode, apiKey: String(form.get("apiKey") ?? "") || undefined,
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

import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityMode } from "@/lib/llm/capacity";
import { findStaleCapacityRoutes, type StaleRoutesResult } from "@/lib/llm/capacity-retire";
import { pruneStaleCapacityRoutes, readCapacityReferenceSnapshot, retireCapacityDevice } from "@/lib/llm/capacity-retire-repository";
import { logger } from "@/lib/observability/logger";
import { DrWriterFencedError } from "./dr/epoch";

/**
 * 관리자 「쓰지 않는 장비 지우기」·「남은 정책 route 정리」(2026-11-09) — 저장소(lib/llm/capacity-retire-repository.ts) 한 TX 를 열고, 거절 코드를 한국어로 푼다.
 * 확인 두 단계(목록 보기 → 확인)는 화면의 일이고, 서버 action 은 confirm=yes 와 고를 때 본 판(장비 version·정책 revision)을 반드시 받는다.
 * 감사 줄은 저장소가 같은 TX 에서 쓴다(여기서 또 쓰지 않는다). OPEN 중에도 된다 — 근거는 removeCapacityRoutes 주석.
 */
export type CapacityRetireResult = { ok: true; message: string } | { ok: false; issues: string[] };
export const CAPACITY_RETIRE_CONFIRM = "yes";

const REFUSAL = /^(model_capacity_|site_fenced$)/;
async function writeTx<T>(work: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  return onPrimary(() => db.transaction(async tx => {
    // control 행을 쥔 채 오래 머물면 모든 입장이 멈춘다 — 잠금은 짧게 기다리고 문장도 짧게 끊는다
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    return work(tx);
  }));
}
function refusal(error: unknown, label: string): CapacityRetireResult {
  if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
  const code = error instanceof Error ? error.message : String(error);
  if (REFUSAL.test(code)) return { ok: false, issues: [code] };
  const pg = (error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : error) as { code?: unknown };
  if (pg.code === "55P03") return { ok: false, issues: ["model_capacity_retire_lock_timeout"] };
  logger.warn(`${label}.failed`, { code: typeof pg.code === "string" ? pg.code : null, error: code.slice(0, 200) });
  return { ok: false, issues: ["model_capacity_retire_failed"] };
}
const validActor = (actor: string) => !!actor.trim() && actor.length <= 120;

/** 장비 한 대 은퇴 — retireCapacityDevice 를 쓰기 TX 하나에서 */
export async function retireAdminCapacityDevice(input: { deviceId: string; expectedVersion: number | null }, actor: string): Promise<CapacityRetireResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  try {
    const result = await writeTx(tx => retireCapacityDevice(tx, input, actor));
    logger.info("model_capacity_device.retired", { actor, deviceId: result.deviceId, mode: result.mode, routes: result.removedRoutes.length,
      revision: result.policy.after.revision });
    return { ok: true, message: `장비 ${result.deviceId}을(를) 지웠습니다 — ${result.deletedRow ? "장비 행·역할 순서, " : ""}정책 route ${result.removedRoutes.length}개`
      + `${result.removedGroupLimit !== null ? `, groupLimits 키(${result.removedGroupLimit}칸)` : ""}를 뺐습니다`
      + `${result.policy.written ? ` (정책 판 ${result.policy.before.revision} → ${result.policy.after.revision}, 접수 ${modeLabel(result.mode)} 그대로)` : ""}.` };
  } catch (error) { return refusal(error, "model_capacity_device.retire"); }
}

/** 남은 route 정리 — pruneStaleCapacityRoutes 를 쓰기 TX 하나에서 */
export async function pruneAdminStaleCapacityRoutes(input: { routes: { routeId: string; provider: string; model: string; groupId: string }[]; expectedRevision: number },
  actor: string): Promise<CapacityRetireResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  try {
    const result = await writeTx(tx => pruneStaleCapacityRoutes(tx, input, actor));
    logger.info("model_capacity_routes.pruned", { actor, mode: result.mode, routes: result.removed.length, revision: result.policy.after.revision });
    return { ok: true, message: `정책 route ${result.removed.length}개를 뺐습니다(정책 판 ${result.policy.before.revision} → ${result.policy.after.revision}, 접수 ${modeLabel(result.mode)} 그대로): `
      + result.removed.map(entry => `${entry.route.routeId} / ${entry.route.model} → ${entry.route.groupId}`).join(" · ") };
  } catch (error) { return refusal(error, "model_capacity_routes.prune"); }
}

export type AdminStaleCapacityRoutesView = (StaleRoutesResult & { mode: ModelCapacityMode; revision: number; error: null })
  | { mode: null; revision: null; candidates: []; kept: []; orphanDevices: []; error: string };
/** 읽기 전용(잠그지 않음) — 지금 정책 판(revision)과 정리 후보·지우면 안 되는 route·연결 없는 장비. 정리 action 에 이 revision 을 넘긴다 */
export async function readAdminStaleCapacityRoutes(): Promise<AdminStaleCapacityRoutesView> {
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const [row] = await tx.execute<{ mode: ModelCapacityMode; revision: string | number; policy: unknown; policy_hash: string | null }>(sql`
        SELECT mode, revision, policy, policy_hash FROM model_capacity_control WHERE id = 1`);
      if (!row) throw new Error("model_capacity_control_missing");
      const policy = row.policy === null ? null : parseModelCapacityPolicy(row.policy);
      if (policy && modelCapacityPolicyHash(policy) !== row.policy_hash) throw new Error("model_capacity_policy_hash_mismatch");
      const verdict = findStaleCapacityRoutes(await readCapacityReferenceSnapshot(tx, policy?.routes ?? []));
      return { ...verdict, mode: row.mode, revision: Number(row.revision), error: null };
    }, { accessMode: "read only", isolationLevel: "repeatable read" }));
  } catch (error) {
    const code = error instanceof Error && REFUSAL.test(error.message) ? error.message : "model_capacity_retire_read_failed";
    return { mode: null, revision: null, candidates: [], kept: [], orphanDevices: [], error: code };
  }
}

// ---------- 폼 → 입력 ----------
type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
const field = (form: FormLike, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const positiveInt = (raw: string) => /^\d{1,16}$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 1 ? Number(raw) : null;

/** 폼 칸: confirm(= "yes") · deviceId · expectedVersion(빈 값 = 행 없이 정책에만 있는 장비) */
export function retireInputFromForm(form: FormLike): { input: { deviceId: string; expectedVersion: number | null } | null; issues: string[] } {
  if (field(form, "confirm") !== CAPACITY_RETIRE_CONFIRM) return { input: null, issues: ["model_capacity_retire_unconfirmed"] };
  const deviceId = field(form, "deviceId"), version = field(form, "expectedVersion");
  if (!deviceId) return { input: null, issues: ["model_capacity_device_retire_invalid:deviceId"] };
  const expectedVersion = version === "" ? null : positiveInt(version);
  if (version !== "" && expectedVersion === null) return { input: null, issues: ["model_capacity_device_retire_invalid:expectedVersion"] };
  return { input: { deviceId, expectedVersion }, issues: [] };
}

/** 폼 칸: confirm(= "yes") · expectedRevision · route(여러 개, 각 JSON `[routeId, provider, model, groupId]`) */
export function pruneInputFromForm(form: FormLike): { input: { routes: { routeId: string; provider: string; model: string; groupId: string }[]; expectedRevision: number } | null;
  issues: string[] } {
  if (field(form, "confirm") !== CAPACITY_RETIRE_CONFIRM) return { input: null, issues: ["model_capacity_retire_unconfirmed"] };
  const expectedRevision = positiveInt(field(form, "expectedRevision"));
  if (expectedRevision === null) return { input: null, issues: ["model_capacity_routes_prune_invalid:expectedRevision"] };
  const routes: { routeId: string; provider: string; model: string; groupId: string }[] = [];
  for (const entry of form.getAll("route")) {
    let parsed: unknown = null;
    try { parsed = typeof entry === "string" ? JSON.parse(entry) : null; } catch { parsed = null; }
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some(part => typeof part !== "string"))
      return { input: null, issues: ["model_capacity_routes_prune_invalid:routes"] };
    const [routeId, provider, model, groupId] = parsed as string[];
    routes.push({ routeId, provider, model, groupId });
  }
  if (!routes.length) return { input: null, issues: ["model_capacity_routes_prune_invalid:routes"] };
  return { input: { routes, expectedRevision }, issues: [] };
}

// ---------- 거절 코드 → 한국어 ----------
const modeLabel = (mode: ModelCapacityMode) => mode === "open" ? "OPEN" : mode === "draining" ? "DRAIN" : "꺼짐";
const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  connection: "이 장비에 묶인 AI 연결", exposed: "이 모델을 아직 내보내는 연결", rank: "작업 순위", pool: "작업 분산 풀", helper: "모델 배정",
  contract: "켜진 서빙 계약", ledger: "끝나지 않은 장부 행", cli: "CLI 경로(connect 에이전트·단계 풀 설정이 부름)",
};
function blockerLines(text: string): string {
  return text.split(" | ").filter(Boolean).map(part => {
    const at = part.indexOf("=");
    const kind = at < 0 ? part : part.slice(0, at), detail = at < 0 ? "" : part.slice(at + 1);
    return `${BLOCKER_LABELS[kind] ?? kind}${detail ? ` ${detail}` : ""}`;
  }).join(" · ");
}
const FIXED: Readonly<Record<string, string>> = {
  site_fenced: "이 사이트는 지금 쓰기가 막혀 있습니다(DR).",
  invalid_actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요.",
  model_capacity_retire_unconfirmed: "확인(confirm=yes)이 없어 아무것도 지우지 않았습니다. 목록을 다시 보고 확인을 눌러주세요.",
  model_capacity_retire_lock_timeout: "용량 제어 행이 바빠 잠금을 얻지 못했습니다 — 아무것도 바뀌지 않았습니다. 잠시 뒤 다시 시도해주세요.",
  model_capacity_retire_failed: "지우지 못했습니다(아무것도 바뀌지 않았거나 결과를 확인하지 못했습니다). 새로고침해 현재 상태를 확인한 뒤 다시 시도해주세요.",
  model_capacity_retire_read_failed: "정리 후보를 읽지 못했습니다.",
  model_capacity_replay_unsupported: "재생(replay) DB 에서는 지울 수 없습니다.",
  model_capacity_control_missing: "용량 제어 행(model_capacity_control)이 없습니다.",
  model_capacity_policy_hash_mismatch: "정책 JSON 이 저장된 hash 와 맞지 않아 쓰지 않았습니다(pipeline-control status 로 확인).",
  model_capacity_policy_missing: "용량 정책이 없어 뺄 route 가 없습니다.",
  model_capacity_device_already_retired: "이미 지운 장비입니다 — 장비 행·정책 route·groupLimits 키가 모두 없습니다(두 번 쓰지 않았습니다).",
  model_capacity_route_conflict: "같은 route 가 다른 장비에 있습니다 — 새로고침해 다시 골라주세요.",
  model_capacity_routes_empty: "정책에 route 가 하나도 남지 않게 됩니다 — 마지막 route 는 뺄 수 없습니다.",
  model_capacity_append_chain_full: "옛 정책 세대에 아직 끝나지 않은 행이 많아(앞 판 사슬 16칸) 지금은 정책을 바꿀 수 없습니다 — 그 행들이 끝난 뒤 다시 시도해주세요.",
  model_capacity_revision_exhausted: "정책 판 번호가 상한에 닿았거나 그 사이 정책이 바뀌었습니다 — 새로고침 후 다시 시도해주세요.",
};
/** 저장소·폼의 거절 코드를 운영자 문장으로. 모르는 코드는 그대로 보인다(숨기지 않는다) */
export function capacityRetireIssueMessage(issue: string): string {
  if (FIXED[issue]) return FIXED[issue];
  const colon = issue.indexOf(":");
  if (colon < 0) return issue;
  const code = issue.slice(0, colon), detail = issue.slice(colon + 1);
  switch (code) {
    case "model_capacity_device_retire_invalid": return `장비 지우기 입력이 틀립니다(${detail}). 새로고침해주세요.`;
    case "model_capacity_routes_prune_invalid": return `route 정리 입력이 틀립니다(${detail}). 새로고침해주세요.`;
    case "model_capacity_device_retire_version_mismatch":
      return `그 사이 장비 설정이 바뀌었습니다(지금 판 ${detail === "none" ? "없음" : detail}). 새로고침해 확인한 뒤 다시 시도해주세요.`;
    case "model_capacity_routes_prune_revision_mismatch":
      return `그 사이 정책이 바뀌었습니다(지금 판 ${detail}). 새로고침해 후보를 다시 본 뒤 시도해주세요.`;
    case "model_capacity_device_retire_blocked": return `아직 쓰이고 있어 장비를 지우지 않았습니다 — ${blockerLines(detail)}. 먼저 그것을 옮기거나 끈 뒤 다시 시도해주세요.`;
    case "model_capacity_route_prune_blocked": {
      const [key, ...rest] = detail.split(" | ");
      return `아직 쓰이고 있어 route ${key.replaceAll("|", " / ")}를 빼지 않았습니다 — ${blockerLines(rest.join(" | ")) || "근거를 다시 확인하세요"}.`;
    }
    case "model_capacity_route_missing": return `route ${detail.replaceAll("|", " / ")}는 이미 정책에 없습니다(두 번 쓰지 않았습니다). 새로고침해주세요.`;
    case "model_capacity_route_unsettled": return `뺄 route 에 끝나지 않은 장부 행이 ${detail}건 있습니다 — 그 행이 끝나거나 사람 검토로 닫힌 뒤 다시 시도해주세요.`;
    case "model_capacity_group_in_use": return `다른 route 가 아직 장비 ${detail}의 groupLimits 키를 씁니다.`;
    default: return issue;
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { aiTask, aiTaskSlotLabel, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { AI_TASK_IMPORT_CONFIRM, aiConnectionInputFromForm, aiModelsErrorText, aiTaskIssueMessage, aiTaskRanksInputFromForm } from "@/lib/operations/admin-ai-tasks";
import { applyAiTaskImport, clearUnreadAiTaskRanks, deleteAiConnection, readAiConnectionModels, saveAiConnection, saveAiTaskRanks, setAiConnectionModelsHidden } from "@/lib/operations/admin-ai-tasks-repository";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type AiTaskActionState = { ok?: true; message?: string; issues?: string[]; warnings?: string[];
  /** 연결 저장이 만들거나 고친 연결 id — LLM 운영 화면이 저장 직후 그 연결의 모델 목록을 보인다 */
  connectionId?: string } | null;

const DENIED: AiTaskActionState = { issues: [aiTaskIssueMessage("denied")] };
// 전체 흐름(/admin/flow)의 「바꾸기」 서랍도 같은 순위 저장을 부른다 — 저장 뒤 그 화면의 칸 모델·최근 바뀐 설정도 새로 읽는다
const PATHS = ["/admin/models/tasks", "/admin/models", "/admin/models/llm", "/admin/models/contracts", "/admin/models/devices", "/admin/flow", "/admin/models/search", "/admin/models/human"];
const revalidate = () => { for (const path of PATHS) revalidatePath(path); };
const field = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const messages = (issues: readonly string[]) => issues.map(aiTaskIssueMessage);

/**
 * 「AI 연결」 저장(만들기·고치기). 쓰기 관문(webWriteAction) → 관리자 확인 → 폼 읽기 → saveAiConnection(API 는 저장 전에 GET /models 를 한 번 읽는다,
 * 키는 암호화해 두고 돌려주지 않는다, 감사 한 줄). 목록을 못 읽어도 연결은 저장하고 그 이유를 알린다.
 */
export const saveAiConnectionAction = webWriteAction(async function saveAiConnectionAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const parsed = aiConnectionInputFromForm(form);
  if (!parsed.input) return { issues: messages(parsed.issues) };
  const saved = await saveAiConnection(parsed.input, admin.login);
  if (!saved.ok) return { issues: messages(saved.issues) };
  revalidate();
  const models = parsed.input.kind === "cli" ? `CLI 모델 ${parsed.input.cliModels.length}개` : saved.modelsError
    ? `모델 목록을 읽지 못했습니다(${aiModelsErrorText(saved.modelsError)}) — 주소·키를 확인하고 「다시 읽기」를 누르세요`
    : `모델 ${saved.models ?? 0}개를 읽었습니다`;
  return { ok: true, connectionId: saved.id, message: `「${parsed.input.label}」 연결을 ${saved.created ? "만들었습니다" : "저장했습니다"}(판 ${saved.version}). ${models}.` };
});

/** 「다시 읽기」 — 저장된 주소·키로 GET /models(1분 간격). */
export const readAiConnectionModelsAction = webWriteAction(async function readAiConnectionModelsAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const read = await readAiConnectionModels(field(form, "id"), admin.login);
  revalidate();
  return read.ok ? { ok: true, message: `모델 ${read.count}개를 읽었습니다.` } : { issues: messages(read.issues) };
});

/** 모델을 연결의 목록에서 빼기(hidden=1)·되돌리기(hidden=0) — 쓰는 순위·작업 분산 구성원이 없는 모델만 뺀다. model 칸은 여러 개(같은 모델의 별칭)일 수 있다. */
export const hideAiConnectionModelAction = webWriteAction(async function hideAiConnectionModelAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const raw = field(form, "expectedVersion"), version = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(version)) return { issues: messages(["ai_connection_invalid:expectedVersion"]) };
  const models = form.getAll("model").flatMap(value => typeof value === "string" && value.trim() ? [value.trim()] : []);
  const hidden = field(form, "hidden") !== "0";
  const result = await setAiConnectionModelsHidden({ id: field(form, "id"), expectedVersion: version, models, hidden }, admin.login);
  if (!result.ok) return { issues: messages(result.issues) };
  revalidate();
  return { ok: true, message: `${models.join(" · ")} — ${hidden ? "목록에서 뺐습니다" : "목록에 되돌렸습니다"}.` };
});

/** 실행 쪽이 순위를 읽지 않는 작업의 옛 순위 행 지우기 — 실행 동작은 그대로다(그 작업의 모델은 단계 풀·감사 설정에서 온다). */
export const clearUnreadAiTaskRanksAction = webWriteAction(async function clearUnreadAiTaskRanksAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const rawSlot = field(form, "slot"), revision = field(form, "revision");
  if (!/^\d$/.test(rawSlot) || !/^[a-f0-9]{64}$/.test(revision)) return { issues: messages(["ai_task_invalid:revision"]) };
  const result = await clearUnreadAiTaskRanks({ task: field(form, "task"), slot: Number(rawSlot), revision }, admin.login);
  if (!result.ok) return { issues: messages(result.issues) };
  revalidate();
  return { ok: true, message: `옛 순위 기록 ${result.removed}개를 지웠습니다.` };
});

/** 쓰는 순위가 없는 연결 지우기. 확인 칸에 연결 이름을 적어야 한다. */
export const deleteAiConnectionAction = webWriteAction(async function deleteAiConnectionAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const raw = field(form, "expectedVersion"), version = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(version)) return { issues: messages(["ai_connection_invalid:expectedVersion"]) };
  if (field(form, "confirm") !== field(form, "label")) return { issues: ["지우려면 확인 칸에 연결 이름을 그대로 적으세요."] };
  const removed = await deleteAiConnection(field(form, "id"), version, admin.login);
  if (!removed.ok) return { issues: messages(removed.issues) };
  revalidate();
  return { ok: true, message: `「${field(form, "label")}」 연결을 지웠습니다.` };
});

/**
 * 「작업 ↔ 모델」 한 줄 저장. 검증 → 준비 확인 → (없으면) 엔진 직접 계약 readback·1토큰 시험 → 한 TX(장비 행·계약·정책 경로 덧붙이기·순위 행·감사).
 * 실행 쪽이 순위를 읽는 작업만 저장합니다. 별도 설정 작업은 실제 적용 편집기로 안내합니다.
 */
export const saveAiTaskRanksAction = webWriteAction(async function saveAiTaskRanksAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const parsed = aiTaskRanksInputFromForm(form);
  if (!parsed.input) return { issues: messages(parsed.issues) };
  const saved = await saveAiTaskRanks(parsed.input, admin.login);
  if (!saved.ok) return { issues: messages(saved.issues) };
  revalidate();
  const task = aiTask(parsed.input.task)!;
  const made = [saved.created.devices.length ? `장비 행 ${saved.created.devices.join(", ")}` : "", saved.created.contracts.length ? `엔진 직접 계약 ${saved.created.contracts.join(", ")}` : "",
    saved.created.routes.length ? `정책 경로 ${saved.created.routes.join(", ")}(DRAIN 없음)` : ""].filter(Boolean);
  const count = parsed.input.ranks.filter(Boolean).length;
  return { ok: true, warnings: saved.warnings,
    message: `${aiTaskSlotLabel(task, parsed.input.slot)}: ${count ? `${count}개 순위를 저장했습니다` : "순위를 비웠습니다"}.${made.length ? ` 함께 만든 것: ${made.join(" · ")}.` : ""}`
      + (isAiLiveTask(task.id) ? " 워커는 30초 주기로 설정을 다시 읽어 새 작업에 자동 반영합니다. 진행 중인 호출은 기존 모델을 유지합니다."
        : " 이 작업의 실행 쪽은 아직 이 순위를 읽지 않습니다(설정값).") };
});

/** 「지금 설정 가져오기」 적용 — 보여 준 계획 hash 와 같을 때만, 확인 글자 「가져오기」. */
export const applyAiTaskImportAction = webWriteAction(async function applyAiTaskImportAction(_previous: AiTaskActionState, form: FormData): Promise<AiTaskActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (field(form, "confirm") !== AI_TASK_IMPORT_CONFIRM) return { issues: messages(["ai_task_import_confirm_required"]) };
  const applied = await applyAiTaskImport(field(form, "planHash"), admin.login);
  if (!applied.ok) return { issues: messages(applied.issues) };
  revalidate();
  return { ok: true, warnings: applied.warnings, message: `가져왔습니다 — 연결 ${applied.connections}개 · 순위를 채운 칸 ${applied.slots}개`
    + `${applied.skipped ? ` · 그 사이 순위가 생겨 건너뛴 칸 ${applied.skipped}개` : ""}. 새 작업은 30초 안에 이 순위를 읽습니다.` };
});

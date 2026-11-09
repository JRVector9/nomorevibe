import { beforeEach, describe, expect, it, vi } from "vitest";

// 모델 상한(0170) — 폼 → 저장 입력·거절/경고 문장·바뀐 줄·server action. DB 없이 본다; 저장소 저장은 가짜다(진짜는 tests/integration/capacity-model-limits.test.ts).
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/llm/capacity-devices-repository", () => ({ saveModelCapacityModelLimits: mocks.save }));
vi.mock("@/lib/db", () => ({ db: { transaction: (work: (tx: unknown) => unknown) => work({}) }, onPrimary: (run: () => unknown) => run() }));

import { saveModelLimitsAction } from "@/app/(operator)/admin/models/devices/actions";
import { modelLimitChangeLines, modelLimitIssueMessage, modelLimitsInputFromForm, modelLimitWarningMessage, saveAdminModelLimits } from "@/lib/operations/admin-capacity-model-limits";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";

const DEEPSEEK = "deepseek-v4.1-flash-1017", GPT = "gpt-oss-120b";
const form = (entries: [string, string][]) => { const data = new FormData(); for (const [key, value] of entries) data.append(key, value); return data; };
const mlxForm = (version = "4", extra: [string, string][] = []) => form([["deviceId", "m3-mlx"], ["expectedVersion", version],
  ["model", DEEPSEEK], [`max:${DEEPSEEK}`, "1"], [`engine:${DEEPSEEK}`, "1"], ["model", GPT], [`max:${GPT}`, "2"], [`engine:${GPT}`, "4"], ...extra]);
const savedRow = (limits: { model: string; maxSlots: number; engineMax: number | null }[], version = 5) => ({ deviceId: "m3-mlx", version, limitSlots: 2, modelLimits: limits });

beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockResolvedValue({ login: "jr" }); });

describe("modelLimitsInputFromForm", () => {
  it("reads one line per model, drops an empty max (no cap) and reads an empty engine as unknown", () => {
    expect(modelLimitsInputFromForm(mlxForm())).toEqual({ issues: [], input: { deviceId: "m3-mlx", expectedVersion: 4,
      limits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }] } });
    const parsed = modelLimitsInputFromForm(form([["deviceId", "m3-mlx"], ["expectedVersion", "4"], ["model", DEEPSEEK], [`max:${DEEPSEEK}`, ""],
      ["model", GPT], [`max:${GPT}`, "3"], [`engine:${GPT}`, ""], ["model", GPT]]));
    expect(parsed.input?.limits).toEqual([{ model: GPT, maxSlots: 3, engineMax: null }]);
  });

  it("names a malformed number or a missing version without building an input", () => {
    expect(modelLimitsInputFromForm(mlxForm("", [])).issues).toEqual(["판 번호(version)를 읽지 못했습니다. 새로고침해주세요."]);
    const bad = modelLimitsInputFromForm(form([["deviceId", "m3-mlx"], ["expectedVersion", "4"], ["model", GPT], [`max:${GPT}`, "two"],
      ["model", DEEPSEEK], [`max:${DEEPSEEK}`, "1"], [`engine:${DEEPSEEK}`, "-1"]]));
    expect(bad).toEqual({ input: null, issues: [`${GPT}: 최대 칸은 0~256 의 정수이거나 비워 둡니다.`, `${DEEPSEEK}: 엔진 최대는 1~256 의 정수이거나 비워 둡니다(모름).`] });
  });
});

describe("messages", () => {
  const sent = [{ model: GPT }, { model: DEEPSEEK }];
  it.each([
    ["model_capacity_model_limit_invalid:limits.0.maxSlots:exceeds_engine", `${GPT}: 최대 칸이 엔진 최대보다 많습니다 — 엔진 최대 이하로 적거나, 엔진 최대를 고쳐 주세요.`],
    ["model_capacity_model_limit_invalid:limits.1.maxSlots", `${DEEPSEEK}: 최대 칸은 0~256 의 정수입니다(0 = 이 장비에서 이 모델을 뺌).`],
    ["model_capacity_model_limit_invalid:limits.1.engineMax", `${DEEPSEEK}: 엔진 최대는 1~256 의 정수이거나 비워 둡니다(모름).`],
    ["model_capacity_model_limit_invalid:limits.5.model", "6번째 줄: 모델 이름이 1~200자가 아니거나 앞뒤 공백·제어 문자가 있습니다. 새로고침해주세요."],
    ["model_capacity_model_limit_invalid:limits:duplicate_model", "같은 모델이 두 번 있습니다. 새로고침해주세요."],
    ["model_capacity_model_limit_invalid:limits", "모델 상한은 장비 하나에 64줄까지입니다."],
    ["model_capacity_model_limit_invalid:root", "모델 상한 입력 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해주세요."],
    ["model_capacity_model_limit_version_mismatch:7", "다른 곳(장비 한도·칸 배분)에서 이 장비를 먼저 저장했습니다(지금 판 7). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."],
    ["model_capacity_model_limit_device_unconfigured", "이 장비는 장비 행이 없거나 꺼져 있어 모델 상한을 둘 수 없습니다 — 장비 한도에서 장비 행을 먼저 저장하거나 켜 주세요."],
  ])("%s", (code, message) => expect(modelLimitIssueMessage(code, sent)).toBe(message));

  it("warns (saved) above the shared limit, for an unmapped model and an unreadable policy", () => {
    expect(modelLimitWarningMessage(`max_exceeds_limit:${GPT}`)).toBe(`${GPT}: 최대 칸이 장비 공유 칸 수보다 큽니다 — 상한은 저장했지만 공유 칸 수가 먼저 막습니다.`);
    expect(modelLimitWarningMessage("model_unmapped:qwen")).toBe("qwen: 지금 정책에서 이 모델이 이 장비로 오지 않습니다 — 상한은 저장했고, 이 장비로 오면 그때부터 적용됩니다.");
    expect(modelLimitWarningMessage("policy_unreadable")).toContain("용량 정책을 읽지 못해");
    expect(modelLimitWarningMessage("other")).toBe("other");
  });

  it("lists only the changed models", () => {
    expect(modelLimitChangeLines([{ model: GPT, maxSlots: 4, engineMax: null }, { model: DEEPSEEK, maxSlots: 1, engineMax: 1 }],
      [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }, { model: "qwen", maxSlots: 0, engineMax: null }]))
      .toEqual([`${GPT}: 최대 4칸 → 최대 2칸 (엔진 4)`, "qwen: 상한 없음 → 최대 0칸"]);
    expect(modelLimitChangeLines([{ model: GPT, maxSlots: 2 }], [])).toEqual([`${GPT}: 최대 2칸 → 상한 없음`]);
  });
});

describe("saveAdminModelLimits and saveModelLimitsAction", () => {
  it("saves through the repository in one transaction and returns the change lines and warnings", async () => {
    mocks.save.mockResolvedValue({ before: [], after: savedRow([{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }]), warnings: [] });
    const input = { deviceId: "m3-mlx", expectedVersion: 4, limits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }] };
    expect(await saveAdminModelLimits(input, "jr")).toEqual({ ok: true, deviceId: "m3-mlx", version: 5, changes: [`${DEEPSEEK}: 상한 없음 → 최대 1칸 (엔진 1)`], warnings: [] });
    expect(mocks.save).toHaveBeenCalledWith({}, input, "jr");
    expect(await saveAdminModelLimits(input, " ")).toEqual({ ok: false, issues: ["invalid_actor"] });
  });

  it("returns refusals and the DR fence as issues and rethrows a DB error", async () => {
    const input = { deviceId: "m3-mlx", expectedVersion: 4, limits: [] };
    mocks.save.mockRejectedValueOnce(new Error("model_capacity_model_limit_version_mismatch:5"));
    expect(await saveAdminModelLimits(input, "jr")).toEqual({ ok: false, issues: ["model_capacity_model_limit_version_mismatch:5"] });
    mocks.save.mockRejectedValueOnce(new DrWriterFencedError("site_fenced"));
    expect(await saveAdminModelLimits(input, "jr")).toEqual({ ok: false, issues: ["site_fenced"] });
    mocks.save.mockRejectedValueOnce(new Error("connection reset"));
    await expect(saveAdminModelLimits(input, "jr")).rejects.toThrow("connection reset");
  });

  it("the action checks the admin, parses the form, saves as the admin, revalidates the model pages and words the result in Korean", async () => {
    mocks.save.mockResolvedValue({ before: [], after: savedRow([{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }]),
      warnings: [`max_exceeds_limit:${GPT}`] });
    const state = await saveModelLimitsAction(null, mlxForm());
    expect(state).toMatchObject({ ok: true, changes: [`${DEEPSEEK}: 상한 없음 → 최대 1칸 (엔진 1)`, `${GPT}: 상한 없음 → 최대 2칸 (엔진 4)`],
      warnings: [`${GPT}: 최대 칸이 장비 공유 칸 수보다 큽니다 — 상한은 저장했지만 공유 칸 수가 먼저 막습니다.`] });
    expect(state?.message).toContain("저장했습니다(장비 m3-mlx, 판 5)");
    expect(mocks.save.mock.calls[0][2]).toBe("jr");
    expect(mocks.revalidate.mock.calls.map(call => call[0])).toEqual(["/admin/models/devices", "/admin/models/allocation", "/admin/models", "/admin/models/llm",
      "/admin/models/tasks", "/admin/status"]);
  });

  it("the action refuses without an admin or with a bad form, and maps a refusal to the sent line's model", async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveModelLimitsAction(null, mlxForm())).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(await saveModelLimitsAction(null, mlxForm("x"))).toEqual({ issues: ["판 번호(version)를 읽지 못했습니다. 새로고침해주세요."] });
    mocks.save.mockRejectedValueOnce(new Error("model_capacity_model_limit_invalid:limits.1.maxSlots:exceeds_engine"));
    expect(await saveModelLimitsAction(null, mlxForm())).toEqual({ issues: [`${GPT}: 최대 칸이 엔진 최대보다 많습니다 — 엔진 최대 이하로 적거나, 엔진 최대를 고쳐 주세요.`] });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

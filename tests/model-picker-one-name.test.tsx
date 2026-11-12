import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));

import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import { TaskExecutionForm } from "@/app/(operator)/admin/models/tasks/TaskExecutionForm";
import { ModelAttachForm } from "@/app/(operator)/admin/models/console/ModelAttachForm";
import { modelPickerChoiceKey, modelPickerOptionName, presentPickerOptions } from "@/app/(operator)/admin/models/model-picker-display";
import { aiTask } from "@/lib/llm/ai-tasks";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { AI_RANK_SLOT_NAMES, aiConnectionModelGroupCount, aiModelChoiceName, aiTaskRankOptions, type AiConnectionView, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildFlowRankEditor, rankForm } from "@/lib/operations/flow-rank-editor";
import { attachDraft, attachPreviewContext, attachSaveForms, attachTargets, savedAssignment } from "@/lib/operations/model-attach";
import { assignmentPreview } from "@/lib/operations/stage-panel-model";
import { poolExecutionForm, poolMembersInput } from "@/lib/operations/task-pool-form";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const options = (html: string) => [...html.matchAll(/<option value="[^"]+"[^>]*>([^<]+)<\/option>/g)].map(match => match[1]);
const SUPA = "Inferact/Qwen3.8-27B-NVFP4";

/** 운영(2026-11-12 읽기 전용 조회)과 같은 모양의 연결 */
function api(id: string, label: string, deviceId: string, served: string[], extra: Partial<AiConnectionView> = {}): AiConnectionView {
  return { id, label, kind: "api", baseUrl: `http://${deviceId}.invalid/v1`, host: `${deviceId}.invalid`, hasKey: true, cliTool: null, cliModels: [],
    models: served.map(model => ({ id: model, maxModelLen: null })), modelsReadAt: null, modelsError: null, deviceId, capacitySlots: 2, contextTokens: null, enabled: true,
    version: 1, note: null, updatedBy: "jr", updatedAt: "2026-11-12T00:00:00.000Z", cliVersion: null, ...extra } as AiConnectionView;
}
// M1max — 서버 목록 하나 + 운영자가 적은 이름 「Qwen3.8」(같은 모델)
const M1MAX = api("aaaaaaaa-0000-4000-8000-000000000001", "M1max", "m1max", ["mlx-community/Qwen3.8-27B-4bit"], { manualModels: ["Qwen3.8"] });
// m1-gemma — M1 Studio 주소(증명된 Gemma 별칭)
const GEMMA = api("aaaaaaaa-0000-4000-8000-000000000002", "m1-gemma", "m1-qwen", ["m1-gemma"], { baseUrl: "https://m1-studio.tail02799e.ts.net/v1" });
// supa-direct — Supa vLLM 주소(supa · Inferact 두 이름이 한 모델)
const SUPA_DIRECT = api("aaaaaaaa-0000-4000-8000-000000000003", "supa-direct", "supa-direct", ["supa", SUPA], { baseUrl: "http://100.78.219.124:8000/v1" });
// 서로 다른 두 모델을 내는 연결
const TWO = api("aaaaaaaa-0000-4000-8000-000000000004", "gpu-pair", "gpu-pair", ["qwen3.8-flash-next", "qwen-vision"]);
const OPENCODE = { ...api("aaaaaaaa-0000-4000-8000-000000000005", "M3 OpenCode", "m3-opencode-host", []), kind: "cli", cliTool: "opencode", models: null, baseUrl: null,
  cliModels: ["opencode/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash", "opencode/glm-5.3"],
  cliCatalog: { models: ["opencode/deepseek-v4.1-flash", "opencode-go/deepseek-v4.1-flash", "opencode/glm-5.3"].map(id => ({ id, vision: false })) } } as unknown as AiConnectionView;
const CONNECTIONS = [M1MAX, GEMMA, SUPA_DIRECT, TWO, OPENCODE];
const task = aiTask("product-translate")!;

describe("고르는 상자 — 모델 목록과 같은 이름 하나(2026-11-12 소유자)", () => {
  it("별칭은 한 줄: M1max 두 이름 → 「M1max」, Gemma 두 이름 → 「m1-gemma」, supa 두 이름 → 「supa-direct」", () => {
    const offered = aiTaskRankOptions(task, CONNECTIONS, [{ connectionId: GEMMA.id, model: "mlx-community--gemma-4-26b-a4b-it-4bit" }]);
    const shown = presentPickerOptions(offered, CONNECTIONS, null);
    expect(shown.filter(row => row.provider === M1MAX.id).map(row => [row.model, row.text])).toEqual([["mlx-community/Qwen3.8-27B-4bit", "M1max"]]);
    expect(shown.filter(row => row.provider === GEMMA.id).map(row => [row.model, row.text])).toEqual([["m1-gemma", "m1-gemma"]]);
    // 새로 고르면 실행 쪽이 쓰는 Inferact 이름(전과 같다)
    expect(shown.filter(row => row.provider === SUPA_DIRECT.id).map(row => [row.model, row.text])).toEqual([[SUPA, "supa-direct"]]);
    // 별칭은 같은 열쇠(관측 칸도 한 모델로 센다)
    expect(modelPickerChoiceKey({ provider: M1MAX.id, model: "Qwen3.8" }, CONNECTIONS)).toBe(modelPickerChoiceKey({ provider: M1MAX.id, model: "mlx-community/Qwen3.8-27B-4bit" }, CONNECTIONS));
    // 모델 목록·도움말이 쓰는 이름도 하나(적은 이름은 서버 목록이 한 묶음이면 그 별칭)
    expect(aiConnectionModelGroupCount(M1MAX)).toBe(1);
    expect(aiModelChoiceName(M1MAX, "Qwen3.8")).toBe("M1max");
  });

  it("저장된 이름은 그대로 — 이 칸에 「supa」·「Qwen3.8」·옛 Gemma 이름으로 저장돼 있으면 그 값이 고른 줄", () => {
    const offered = aiTaskRankOptions(task, CONNECTIONS, [{ connectionId: GEMMA.id, model: "mlx-community--gemma-4-26b-a4b-it-4bit" }]);
    expect(presentPickerOptions(offered, CONNECTIONS, { provider: SUPA_DIRECT.id, model: "supa" }).find(row => row.provider === SUPA_DIRECT.id)).toMatchObject({ model: "supa", text: "supa-direct" });
    expect(presentPickerOptions(offered, CONNECTIONS, { provider: M1MAX.id, model: "Qwen3.8" }).find(row => row.provider === M1MAX.id)).toMatchObject({ model: "Qwen3.8", text: "M1max" });
    expect(presentPickerOptions(offered, CONNECTIONS, { provider: GEMMA.id, model: "mlx-community--gemma-4-26b-a4b-it-4bit" }).find(row => row.provider === GEMMA.id))
      .toMatchObject({ model: "mlx-community--gemma-4-26b-a4b-it-4bit", text: "m1-gemma" });
    const html = renderToStaticMarkup(<RankSelects stage={{ id: "t", label: "공개 번역", slots: 1 }} options={offered} connections={CONNECTIONS} value={[{ provider: SUPA_DIRECT.id, model: "supa" }]}
      onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />);
    expect(html).toContain('name="rank1Model" value="supa"');
    expect(html).not.toContain("<optgroup");
  });

  it("한 연결이 서로 다른 모델을 내면 「이름 · 구분」, OpenCode 는 DeepSeek 만 이름 먼저", () => {
    const offered = aiTaskRankOptions(task, CONNECTIONS, []);
    const html = renderToStaticMarkup(<RankSelects stage={{ id: "t", label: "공개 번역", slots: 1 }} options={offered} connections={CONNECTIONS} value={[null]}
      onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />);
    const names = options(html).map(name => name.replace(/ — .*$/, ""));
    // 차례는 받은 선택지 그대로(API 먼저, 이름순)
    expect(names).toEqual(["gpu-pair · qwen3.8-flash-next", "gpu-pair · qwen-vision", "m1-gemma", "M1max", "supa-direct",
      "M3 OpenCode · opencode/deepseek-v4.1-flash", "M3 OpenCode · opencode-go/deepseek-v4.1-flash"]);
    // 장비 id·서버 모델 이름(Gemma 4 26B · Inferact…)은 보이지 않는다
    expect(text(html)).not.toMatch(/m1-qwen|Gemma 4 26B|Inferact|mlx-community/);
  });

  it("지금 목록에 없는 저장된 값은 「이름 · 서버 이름 (목록에 없음)」으로 남는다", () => {
    const offered = aiTaskRankOptions(task, CONNECTIONS, [{ connectionId: M1MAX.id, model: "old-qwen" }]);
    const shown = presentPickerOptions(offered, CONNECTIONS, { provider: M1MAX.id, model: "old-qwen" });
    expect(shown.filter(row => row.provider === M1MAX.id).map(row => [row.model, row.text])).toEqual([["mlx-community/Qwen3.8-27B-4bit", "M1max"],
      ["old-qwen", "M1max · old-qwen (목록에 없음)"]]);
    expect(modelPickerOptionName(TWO, "qwen-vision")).toBe("gpu-pair · qwen-vision");
  });
});

// ── 모델에서 바로 붙이기 ──
const rows: AiTaskRankRow[] = [
  { task: "product-translate", slot: 1, rank: 1, connectionId: SUPA_DIRECT.id, model: "supa", options: {}, enabled: true },
  { task: "product-translate", slot: 1, rank: 2, connectionId: GEMMA.id, model: "m1-gemma", options: {}, enabled: true },
];
const executions: AiTaskExecutionAdminView[] = [{ task: "reason-translate", slot: 1, mode: "workload_pool", revision: 4, updatedAt: null, reserveRanks: false,
  members: [{ memberId: "11111111-1111-4111-8111-111111111111", position: 1, connectionId: GEMMA.id, model: "m1-gemma", options: {}, canonicalModel: "m1-gemma",
    deviceId: "m1-qwen", engineKey: "e".repeat(64), maxSlots: 2 }] } as unknown as AiTaskExecutionAdminView];
const editor = buildFlowRankEditor(CONNECTIONS, rows, () => "r".repeat(64), executions);

describe("모델에서 바로 붙이기 — 단계 고르기 · 순위대로 / 함께 · 저장 전 확인 · 같은 저장", () => {
  it("이 모델을 받는 단계만 — 쓸 수 있는 단계를 줄인 모델은 그 단계만", () => {
    const keys = attachTargets(editor, M1MAX.id).map(target => target.key);
    expect(keys).toContain("product-translate#1");
    expect(keys).not.toContain("product-intro-check#1");
    const limited = { ...M1MAX, allowedTasks: ["product-translate"] } as AiConnectionView;
    const only = buildFlowRankEditor([limited, ...CONNECTIONS.slice(1)], rows, () => "r".repeat(64), executions);
    expect(attachTargets(only, M1MAX.id).map(target => target.key)).toEqual(["product-translate#1"]);
    expect(attachTargets(editor, M1MAX.id).find(target => target.key === "product-translate#1")).toMatchObject({ rank: true, pool: true, using: false });
  });

  it("순위대로 — 고른 순위에 넣고 뒤는 밀린다 · 함께 — 지금 1순위와 함께 시작, 예비 켬", () => {
    const line = editor.lines.find(entry => entry.key === "product-translate#1")!;
    const before = savedAssignment(line);
    const choice = { provider: M1MAX.id, model: "mlx-community/Qwen3.8-27B-4bit" };
    const features = { slotCaps: true, reserve: true };
    expect(attachDraft({ before, choice, mode: "rank", rank: 1, features }).ranks.map(row => row?.provider)).toEqual([M1MAX.id, SUPA_DIRECT.id, GEMMA.id]);
    expect(attachDraft({ before, choice, mode: "rank", rank: 3, features }).ranks.map(row => row?.provider)).toEqual([SUPA_DIRECT.id, GEMMA.id, M1MAX.id]);
    const pool = attachDraft({ before, choice, mode: "pool", rank: 0, slots: ["2", "2"], features });
    expect(pool).toMatchObject({ mode: "workload_pool", reserve: true });
    expect(pool.members.map(row => row?.provider)).toEqual([SUPA_DIRECT.id, M1MAX.id]);
    // 이미 「동시에」면 구성원에 더한다
    const reason = editor.lines.find(entry => entry.key === "reason-translate#1")!;
    expect(attachDraft({ before: savedAssignment(reason), choice, mode: "pool", rank: 0, features }).members.map(row => row?.provider)).toEqual([GEMMA.id, M1MAX.id]);
  });

  it("저장은 작업 배정과 같은 폼 칸 — 실행 방식(poolExecutionForm)·순위(rankForm)", () => {
    const line = editor.lines.find(entry => entry.key === "product-translate#1")!;
    const before = savedAssignment(line);
    const choice = { provider: M1MAX.id, model: "mlx-community/Qwen3.8-27B-4bit" };
    const features = { slotCaps: true, reserve: true };
    const ranked = attachDraft({ before, choice, mode: "rank", rank: 2, features });
    const [rankSave] = attachSaveForms({ line, after: ranked, features, saves: ["ranks"] });
    expect(rankSave.kind).toBe("ranks");
    expect([...rankSave.form.entries()]).toEqual([...rankForm(line, ranked.ranks).entries()]);
    const pooled = attachDraft({ before, choice, mode: "pool", rank: 0, slots: ["2", "1"], features });
    const [poolSave] = attachSaveForms({ line, after: pooled, features, saves: ["execution"] });
    const expected = poolExecutionForm({ task: "product-translate", slot: 1, revision: null, mode: "workload_pool",
      members: poolMembersInput(pooled.members, pooled.slots ?? [], [], features), reserve: true });
    expect([...poolSave.form.entries()]).toEqual([...expected.entries()]);
    expect(JSON.parse(String(poolSave.form.get("members")))).toEqual([{ connectionId: SUPA_DIRECT.id, model: "supa", maxSlots: 2 },
      { connectionId: M1MAX.id, model: "mlx-community/Qwen3.8-27B-4bit", maxSlots: 1 }]);
  });

  it("「동시에」인 단계에 순위대로 붙이면 방식을 되돌리고 그 순위도 저장한다(실행 방식 → 순위 차례)", () => {
    const line = editor.lines.find(entry => entry.key === "reason-translate#1")!;
    const before = savedAssignment(line);
    const features = { slotCaps: true, reserve: true };
    const after = attachDraft({ before, choice: { provider: M1MAX.id, model: "mlx-community/Qwen3.8-27B-4bit" }, mode: "rank", rank: 1, features });
    const context = attachPreviewContext(editor, null, id => { const row = CONNECTIONS.find(entry => entry.id === id)!; return { label: row.label, models: [], modelGroups: 1 }; });
    const preview = assignmentPreview({ task: "reason-translate", slot: 1, before, after, context });
    expect(preview.saves).toEqual(["execution", "ranks"]);
    expect(preview.rows.map(row => row.label)).toEqual(["방식", "동시 처리", "순위"]);
    expect(attachSaveForms({ line, after, features, saves: preview.saves }).map(entry => [entry.kind, entry.form.get("mode")])).toEqual([["execution", "fallback"], ["ranks", null]]);
  });

  it("화면 — 단계·모델(이름 하나)·방식, 저장 전 확인에 바뀌는 것", () => {
    const devices = [{ deviceId: "m1max", active: 0, limitSlots: 2 }];
    const edit = renderToStaticMarkup(<ModelAttachForm connectionId={M1MAX.id} editor={editor} devices={devices} poolHelp={null} readOnly={false}
      initial={{ key: "product-translate#1", mode: "rank", rank: 2 }} />);
    expect(edit).toContain('id="model-attach"');
    expect(text(edit)).toContain("모델 M1max");
    expect(edit).toContain('value="product-translate#1" selected=""');
    expect(edit).toMatch(/<option value="2" selected="">2순위<\/option>/);
    expect(text(edit)).toContain("전체 작업 배정 보기");
    const confirm = text(renderToStaticMarkup(<ModelAttachForm connectionId={M1MAX.id} editor={editor} devices={devices} poolHelp={null} readOnly={false}
      initial={{ key: "product-translate#1", mode: "rank", rank: 2, step: "confirm" }} />));
    expect(confirm).toContain("M1max를 2순위로 붙입니다");
    expect(confirm).toContain("순위 supa-direct → m1-gemma supa-direct → M1max → m1-gemma");
    expect(confirm).toContain("순위 저장");
    const pooled = text(renderToStaticMarkup(<ModelAttachForm connectionId={M1MAX.id} editor={editor} devices={devices} poolHelp={null} readOnly={false}
      initial={{ key: "product-translate#1", mode: "pool", slots: ["2", "2"], step: "confirm" }} />));
    expect(pooled).toContain("함께(동시에)로 붙입니다");
    expect(pooled).toContain("방식 순위대로 동시에");
    expect(pooled).toContain("실행 방식 저장");
  });
});

describe("「동시에」 폼의 설명 — #925 도움말과 같은 말(같은 모델 두 줄 대신 칸 수)", () => {
  it("작업 배정 실행 방식 폼과 고르는 상자 밑 줄에 「반복 선택」을 권하는 말이 없다", () => {
    const view = { task: "product-translate", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, reserveRanks: false,
      members: [{ memberId: "11111111-1111-4111-8111-111111111111", position: 1, connectionId: GEMMA.id, model: "m1-gemma", options: {}, canonicalModel: "m1-gemma",
        deviceId: "m1-qwen", engineKey: "e".repeat(64), maxSlots: null }] } as unknown as AiTaskExecutionAdminView;
    const html = text(renderToStaticMarkup(<TaskExecutionForm view={view} label="공개 번역" options={aiTaskRankOptions(task, CONNECTIONS, [])} connections={CONNECTIONS} />));
    expect(html).toContain("같은 모델은 한 줄만 넣고 동시에 여러 개는 칸 수로 정하세요. 두 줄로 넣으면 고를 차례만 늘고 동시 처리 수는 늘지 않습니다.");
    expect(html).toContain("같은 모델은 한 줄만 넣으세요 — 두 줄로 넣으면 고를 차례만 늘고 동시 처리 수는 늘지 않습니다.");
    expect(html).not.toMatch(/반복 선택|반복해도/);
    // 칸 수를 받지 않는 작업(발행 분류)은 칸 수를 말하지 않는다
    const classify = { ...view, task: "publish-classify", members: [] } as unknown as AiTaskExecutionAdminView;
    const plain = text(renderToStaticMarkup(<TaskExecutionForm view={classify} label="발행 분류" options={[]} connections={CONNECTIONS} />));
    expect(plain).toContain("같은 모델은 한 줄만 넣으세요. 두 줄로 넣으면 고를 차례만 늘고 동시 처리 수는 늘지 않습니다.");
    expect(plain).not.toContain("칸 수로 정하세요");
    // 순위대로 상자 밑 줄
    const ranks = text(renderToStaticMarkup(<RankSelects stage={{ id: "t", label: "공개 번역", slots: 1 }} options={aiTaskRankOptions(task, CONNECTIONS, [])} connections={CONNECTIONS}
      value={[null]} onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />));
    expect(ranks).toContain("같은 모델을 여러 순위에 넣어도 동시 처리 수는 늘지 않습니다.");
    expect(ranks).not.toMatch(/반복 선택해도/);
  });
});

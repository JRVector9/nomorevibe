import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import { RankDrawer } from "@/app/(operator)/admin/flow/RankDrawer";
import { modelPickerConnectionDevice, modelPickerConnectionLabel, modelPickerConnectionModels, modelPickerChoiceKey,
  modelPickerVisibleText, presentPickerOptions } from "@/app/(operator)/admin/models/model-picker-display";
import { aiTask } from "@/lib/llm/ai-tasks";
import { AI_RANK_SLOT_NAMES, aiTaskRankOptions, type AiConnectionView, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildFlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { rankOptionKey } from "@/lib/operations/admin-first-review-ranks";

const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit", SUPA = "Inferact/Qwen3.8-27B-NVFP4";
const make = (id: string, label: string, baseUrl: string, models: string[]): AiConnectionView => ({ id, label, baseUrl, models: models.map(id => ({ id, maxModelLen: 131072 })),
  deviceId: label, kind: "api", cliTool: null, cliModels: [], host: new URL(baseUrl).host, hasKey: false, enabled: true,
  modelsReadAt: null, modelsError: null, contextTokens: null, capacitySlots: 1, version: 1, note: null, updatedBy: "fixture", updatedAt: "", cliVersion: null });
const m1 = make("11111111-1111-4111-8111-111111111111", "m1-qwen", "https://m1-studio.tail02799e.ts.net/v1", [GEMMA, "auto"]);
const supa = make("22222222-2222-4222-8222-222222222222", "supa-direct", "http://100.78.219.124:8000/v1", ["supa", SUPA]);
const connections = [m1, supa];
const options = aiTaskRankOptions(aiTask("first-review")!, connections, []);

it("presents known M1 as Gemma only and collapses proven Supa aliases without touching other connections or metadata", () => {
  expect(modelPickerConnectionLabel(m1)).toBe("M1 Studio · Gemma");
  expect(modelPickerConnectionDevice(m1)).toBe("M1 Studio");
  expect(modelPickerVisibleText("m1-qwen · Gemma", connections)).toBe("M1 Studio · Gemma");
  expect(modelPickerConnectionModels(m1)).toEqual([{ id: GEMMA, maxModelLen: 131072 }]);
  expect(modelPickerConnectionModels(supa)).toEqual([{ id: SUPA, maxModelLen: 131072 }]);
  const unrelated = { ...m1, baseUrl: "https://other.example/v1" };
  expect(modelPickerConnectionLabel(unrelated)).toBe("m1-qwen");
  expect(modelPickerConnectionModels(unrelated)).toBe(unrelated.models);
  expect(modelPickerVisibleText("m1-qwen · Gemma", [unrelated])).toBe("m1-qwen · Gemma");
  expect(presentPickerOptions(options, connections, null).map(row => row.model)).toEqual([GEMMA, SUPA]);
  expect(m1.models?.map(row => row.id)).toEqual([GEMMA, "auto"]);
  expect(supa.models?.map(row => row.id)).toEqual(["supa", SUPA]);
});
it("renders one canonical Supa option for a selected legacy alias while preserving the exact hidden form binding", () => {
  const selected = { provider: supa.id, model: "supa" };
  const html = renderToStaticMarkup(<RankSelects stage={{ id: "test", label: "검수", slots: 1 }} options={options} connections={connections}
    value={[selected]} onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />);
  expect(html).toContain('label="M1 Studio · API"');
  expect(html).not.toContain("m1-qwen");
  expect(html).not.toContain('>auto</option>');
  expect(html).toContain(`value="${rankOptionKey(selected)}" selected="">${SUPA} · `);
  expect(html).not.toContain(`value="${rankOptionKey({ provider: supa.id, model: SUPA })}"`);
  expect(html).toContain('name="rank1Model" value="supa"');
  expect(modelPickerChoiceKey(selected, connections)).toBe(modelPickerChoiceKey({ provider: supa.id, model: SUPA }, connections));
});
it("renders the same curated picker inside the flow drawer and keeps stored model identities intact", () => {
  const rows: AiTaskRankRow[] = [{ task: "first-review", slot: 1, rank: 1, connectionId: m1.id, model: GEMMA, options: {}, enabled: true },
    { task: "first-review", slot: 1, rank: 2, connectionId: supa.id, model: "supa", options: {}, enabled: true }];
  const editor = buildFlowRankEditor(connections, rows, () => "a".repeat(64));
  const html = renderToStaticMarkup(<RankDrawer editor={editor} lines={editor.lines.filter(row => row.task === "first-review")}
    title="1차 검수" secondWaiting={null} onClose={() => {}} />);
  expect(html).toContain("M1 Studio");
  expect(html).not.toContain("m1-qwen");
  expect(html).not.toContain('>auto</option>');
  expect(html).toContain(SUPA);
  expect(html).toContain('name="rank2Model" value="supa"');
  expect(editor.connections[0].label).toBe("m1-qwen");
  expect(editor.lines.find(row => row.task === "first-review")?.saved[1].model).toBe("supa");
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));
import { RankSelects } from "@/app/(operator)/admin/models/RankSelects";
import { RankDrawer } from "@/app/(operator)/admin/flow/RankDrawer";
import { modelPickerConnectionDevice, modelPickerConnectionLabel, modelPickerConnectionModels, modelPickerChoiceKey,
  modelPickerModelGroups, modelPickerModelLabel, modelPickerVisibleText, presentPickerOptions } from "@/app/(operator)/admin/models/model-picker-display";
import { aiTask } from "@/lib/llm/ai-tasks";
import { AI_RANK_SLOT_NAMES, aiTaskRankOptions, type AiConnectionView, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildFlowRankEditor } from "@/lib/operations/flow-rank-editor";
import { rankOptionKey } from "@/lib/operations/admin-first-review-ranks";
import * as modelAvailability from "@/app/(operator)/admin/models/use-model-availability";
import { modelPickerActivityParts, modelPickerActivityText, type ModelPickerAvailability } from "@/lib/operations/model-picker-availability";

const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit", SUPA = "Inferact/Qwen3.8-27B-NVFP4";
const make = (id: string, label: string, baseUrl: string, models: string[]): AiConnectionView => ({ id, label, baseUrl, models: models.map(id => ({ id, maxModelLen: 131072 })),
  deviceId: label, kind: "api", cliTool: null, cliModels: [], host: new URL(baseUrl).host, hasKey: false, enabled: true,
  modelsReadAt: null, modelsError: null, contextTokens: null, capacitySlots: 1, version: 1, note: null, updatedBy: "fixture", updatedAt: "", cliVersion: null });
// 운영 그대로: 연결 이름표는 m1-gemma, 장비(정책 groupId)는 옛 이름 m1-qwen
const m1: AiConnectionView = { ...make("11111111-1111-4111-8111-111111111111", "m1-gemma", "https://m1-studio.tail02799e.ts.net/v1", [GEMMA, "auto"]), deviceId: "m1-qwen" };
const supa = make("22222222-2222-4222-8222-222222222222", "supa-direct", "http://100.78.219.124:8000/v1", ["supa", SUPA]);
const connections = [m1, supa];
const options = aiTaskRankOptions(aiTask("first-review")!, connections, []);

it("presents known M1 as Gemma only and collapses proven Supa aliases without touching other connections or metadata", () => {
  // 2026-11-09: 보이는 이름은 연결 이름표 그대로 — 장비 id·주소로 「M1 Studio」 를 지어내지 않는다
  expect(modelPickerConnectionLabel(m1)).toBe("m1-gemma");
  expect(modelPickerConnectionDevice(m1)).toBe("m1-qwen");
  expect(modelPickerVisibleText("m1-qwen · Gemma", connections)).toBe("m1-gemma · Gemma");
  expect(modelPickerConnectionModels(m1)).toEqual([{ id: GEMMA, maxModelLen: 131072 }]);
  expect(modelPickerConnectionModels(supa)).toEqual([{ id: SUPA, maxModelLen: 131072 }]);
  const unrelated = { ...m1, baseUrl: "https://other.example/v1" };
  expect(modelPickerConnectionLabel(unrelated)).toBe("m1-gemma");
  expect(modelPickerConnectionModels(unrelated)).toBe(unrelated.models);
  // 장비 id 가 연결 이름과 같으면 그대로, 다른 이름의 일부·연결 이름표 안은 건드리지 않는다
  expect(modelPickerVisibleText("supa-direct 칸 가득 · m1-qwen-old", connections)).toBe("supa-direct 칸 가득 · m1-qwen-old");
  const shared = [{ ...supa, id: "a", label: "m3-mlx", deviceId: "m3-mlx" }, { ...supa, id: "b", label: "m3-mlx (2)", deviceId: "m3-mlx" }];
  expect(modelPickerVisibleText("m3-mlx (2) · gpt-oss — 장비 m3-mlx 가득", shared)).toBe("m3-mlx (2) · gpt-oss — 장비 m3-mlx 가득");
  const renamed = [{ ...shared[0], label: "m3-deepseek" }, { ...shared[1], label: "m3-gpt-oss" }];
  expect(modelPickerVisibleText("장비 행 m3-mlx이(가) 없습니다", renamed)).toBe("장비 행 m3-deepseek · m3-gpt-oss이(가) 없습니다");
  expect(presentPickerOptions(options, connections, null).map(row => row.model)).toEqual([GEMMA, SUPA]);
  expect(m1.models?.map(row => row.id)).toEqual([GEMMA, "auto"]);
  expect(supa.models?.map(row => row.id)).toEqual(["supa", SUPA]);
});
it("renders one canonical Supa option for a selected legacy alias while preserving the exact hidden form binding", () => {
  const selected = { provider: supa.id, model: "supa" };
  const html = renderToStaticMarkup(<RankSelects stage={{ id: "test", label: "검수", slots: 1 }} options={options} connections={connections}
    value={[selected]} onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />);
  expect(html).toContain('label="m1-gemma · API"');
  expect(html).not.toContain("m1-qwen");
  expect(html).not.toContain('>auto</option>');
  // 고른 선택지는 이름만 — 관측은 상자 밑 줄(data-model-activity)
  expect(html).toContain(`value="${rankOptionKey(selected)}" selected="">${SUPA}</option>`);
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
  expect(html).toContain("m1-gemma");
  // 장비 id 는 연결 상태 표의 title 에만 남는다
  expect(html.replace(/title="[^"]*"/g, "")).not.toContain("m1-qwen");
  expect(html).not.toContain('>auto</option>');
  expect(html).toContain(SUPA);
  expect(html).toContain('name="rank2Model" value="supa"');
  expect(editor.connections[0].label).toBe("m1-gemma");
  expect(editor.connections[0].deviceId).toBe("m1-qwen");
  expect(editor.lines.find(row => row.task === "first-review")?.saved[1].model).toBe("supa");
});

it("2026-11-08: M1 의 새 목록 이름 m1-gemma 도 Gemma 4 26B 한 줄 — 옛 이름으로 저장된 순위는 폼 값 그대로, 새로 고르면 지금 목록 이름", () => {
  const renamed = { ...make(m1.id, "m1-qwen", "https://m1-studio.tail02799e.ts.net/v1", ["m1-gemma"]), label: "m1-gemma" };
  expect(modelPickerModelLabel(renamed, "m1-gemma")).toBe("Gemma 4 26B");
  expect(modelPickerModelLabel(renamed, GEMMA)).toBe("Gemma 4 26B");
  expect(modelPickerConnectionModels(renamed)).toEqual([{ id: "m1-gemma", maxModelLen: 131072 }]);
  const task = aiTask("product-translate")!;
  const offered = aiTaskRankOptions(task, [renamed], [{ connectionId: renamed.id, model: GEMMA }]);
  expect(offered.map(row => row.model)).toEqual(["m1-gemma", GEMMA]);
  expect(presentPickerOptions(offered, [renamed], null).map(row => [row.model, row.text])).toEqual([["m1-gemma", "Gemma 4 26B"]]);
  expect(presentPickerOptions(offered, [renamed], { provider: renamed.id, model: GEMMA }).map(row => [row.model, row.text])).toEqual([[GEMMA, "Gemma 4 26B"]]);
  expect(modelPickerChoiceKey({ provider: renamed.id, model: "m1-gemma" }, [renamed])).toBe(modelPickerChoiceKey({ provider: renamed.id, model: GEMMA }, [renamed]));
});
it("2026-11-08: 같은 모델의 별칭만 한 줄로 묶는다 — Supa 두 이름·M1 Gemma 두 이름, 다른 연결의 다른 모델은 그대로", () => {
  expect(modelPickerModelGroups(supa, ["supa", SUPA])).toEqual([{ label: SUPA, ids: ["supa", SUPA] }]);
  expect(modelPickerModelGroups(m1, ["m1-gemma", GEMMA, "auto"])).toEqual([{ label: "Gemma 4 26B", ids: ["m1-gemma", GEMMA] }, { label: "auto", ids: ["auto"] }]);
  const other = make("33333333-3333-4333-8333-333333333333", "gpu", "http://gpu.invalid/v1", ["supa", SUPA]);
  expect(modelPickerModelGroups(other, ["supa", SUPA])).toEqual([{ label: "supa", ids: ["supa"] }, { label: SUPA, ids: [SUPA] }]);
});

// 2026-11-08 운영자 「주기적으로 깜빡인다·안 읽힌다」 — 고르기 상자의 관측 표시
const observed = (patch: Partial<ModelPickerAvailability["connections"][number]> = {}): ModelPickerAvailability => ({ observedAt: "2026-11-07T14:51:42.000Z", mode: "open",
  connections: [{ connectionId: supa.id, deviceId: "supa-direct", enabled: true, deviceEnabled: true, source: "table", limit: 2, occupied: 0, free: 2, reserved: 0, expiredReserved: 0,
    running: 0, waiting: 0, indeterminate: 1, models: [{ model: "supa", reserved: 0, expiredReserved: 0, running: 0, waiting: 0, indeterminate: 1 }], ...patch }] });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("2026-11-08: 관측 조각 — 글은 예전 한 줄과 같고, 사람이 볼 것(미확정·여유 0·꺼짐)만 warn", () => {
  const connection = observed().connections[0];
  expect(modelPickerActivityParts(connection, connection.models, "open")).toEqual([{ text: "미실행", tone: null }, { text: "미확정 1", tone: "warn" },
    { text: "공유 여유 2/2", tone: null }]);
  expect(modelPickerActivityText(connection, connection.models, "open")).toBe("미실행 · 미확정 1 · 공유 여유 2/2");
  const full = observed({ free: 0, enabled: false }).connections[0];
  expect(modelPickerActivityParts(full, [], "open").filter(part => part.tone === "warn").map(part => part.text)).toEqual(["연결 꺼짐", "공유 여유 0/2"]);
});

it("2026-11-08: 고른 선택지는 이름만, 관측은 상자 밑 조각 — 다시 읽는 중에도 「갱신 중」을 붙이지 않고, 실패하면 마지막 관측과 그 사실을 보인다", () => {
  vi.spyOn(modelAvailability, "useModelAvailability").mockReturnValue({ value: observed(), loading: true, failed: true });
  const selected = { provider: supa.id, model: "supa" };
  const html = renderToStaticMarkup(<RankSelects stage={{ id: "test", label: "검수", slots: 1 }} options={options} connections={connections}
    value={[selected]} onChange={() => {}} slotNames={AI_RANK_SLOT_NAMES} showProvider={false} validate={() => []} />);
  expect(html).toContain(`value="${rankOptionKey(selected)}" selected="">${SUPA}</option>`);
  // 고르지 않은 선택지는 「이름 — 관측」(M1 은 이 관측에 없다)
  expect(html).toContain(">Gemma 4 26B — 슬롯 확인 못함</option>");
  expect(html).toContain('aria-describedby="test-rank-1-activity"');
  expect(html).toMatch(/<span id="test-rank-1-activity"[^>]*data-model-activity="true">(<span[^>]*>[^<]+<\/span>){3}<\/span>/);
  expect(html).toMatch(/data-tone="warn"[^>]*>미확정 1<\/span>/);
  expect(html).not.toMatch(/data-tone="warn"[^>]*>미실행</);
  expect(html).not.toContain("갱신 중");
  expect(html).toContain("(다시 읽기 실패 — 마지막 관측)");
});

it("2026-11-08: 관측을 다시 읽어도 글자를 흔들지 않는다 — 처음만 loading, 실패해도 마지막 관측을 두고, 5초 안에 상자를 다시 스치면 부르지 않는다", async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T00:00:00.000Z"));
  const first = observed();
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, availability: first }) }));
  vi.stubGlobal("fetch", fetchMock);
  const store = await import("@/app/(operator)/admin/models/use-model-availability");
  const opening = store.refreshModelAvailability();
  expect(store.modelAvailabilitySnapshot()).toEqual({ value: null, loading: true, failed: false });
  await opening;
  expect(store.modelAvailabilitySnapshot()).toEqual({ value: first, loading: false, failed: false });
  // 상자를 스치거나 눌러도 5초 안이면 그 값을 쓴다
  vi.setSystemTime(new Date(Date.now() + store.MODEL_AVAILABILITY_FRESH_MS - 1));
  await store.refreshModelAvailability();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // 15초 주기 읽기 — 도는 동안 loading 을 알리지 않고, 실패하면 마지막 관측을 그대로 둔다
  vi.setSystemTime(new Date(Date.now() + 15_000));
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, availability: first }) });
  const background = store.refreshModelAvailability();
  expect(store.modelAvailabilitySnapshot()).toEqual({ value: first, loading: false, failed: false });
  await background;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(store.modelAvailabilitySnapshot()).toEqual({ value: first, loading: false, failed: true });
});

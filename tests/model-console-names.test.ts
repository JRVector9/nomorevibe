import { describe, expect, it, vi } from "vitest";

/** 운영 콘솔 3a 의 이름 둘(모델 이름·장비 묶음 이름)과 서버 root — 연결 읽기·연결 폼 읽기·/models 읽기. DB 는 쓰지 않는다 */
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));
import { aiConnectionInputFromForm } from "@/lib/operations/admin-ai-tasks";
import { aiConnectionView } from "@/lib/operations/admin-ai-tasks-repository";
import { readConnectionModels } from "@/lib/operations/ai-connection-key-fill";

const ID = "4d2c7f1e-0000-4000-8000-00000000e1a0";
const record = (options: Record<string, unknown>, models: unknown = null) => ({ id: ID, label: "supa-direct", kind: "api" as const, baseUrl: "https://supa.example/v1",
  apiKeyCiphertext: null, cliTool: null, cliModels: [], models, modelsReadAt: null, modelsError: null, deviceId: "supa-direct", capacitySlots: 3, options,
  enabled: true, version: 4, note: null, updatedBy: "jr", createdAt: new Date("2026-11-08T00:00:00Z"), updatedAt: new Date("2026-11-08T00:00:00Z") });
const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
const base = { id: ID, expectedVersion: "4", label: "supa-direct", kind: "api", baseUrl: "https://supa.example/v1", deviceId: "supa-direct", capacitySlots: "3" };

describe("모델 이름·장비 묶음 이름(options.displayName · options.machine)", () => {
  it("연결 읽기가 두 이름과 서버 root 를 싣는다 — 모양이 틀린 값은 버린다", () => {
    const view = aiConnectionView(record({ displayName: "supa", machine: "Supa" }, [{ id: "supa", maxModelLen: 131072, root: "Inferact/Qwen3.8-27B-NVFP4" },
      { id: "Inferact/Qwen3.8-27B-NVFP4", maxModelLen: 131072 }]) as never);
    expect([view.displayName, view.machine]).toEqual(["supa", "Supa"]);
    expect(view.models).toEqual([{ id: "supa", maxModelLen: 131072, root: "Inferact/Qwen3.8-27B-NVFP4" }, { id: "Inferact/Qwen3.8-27B-NVFP4", maxModelLen: 131072 }]);
    const odd = aiConnectionView(record({ displayName: "", machine: "x".repeat(81) }) as never);
    expect([odd.displayName, odd.machine]).toEqual([null, null]);
  });

  it("연결 폼 읽기 — 칸이 없으면 undefined(저장된 값 그대로), 빈 값이면 null(지움), 80자 넘으면 거절", () => {
    expect(aiConnectionInputFromForm(form(base)).input).not.toHaveProperty("displayName");
    expect(aiConnectionInputFromForm(form(base)).input).not.toHaveProperty("machine");
    expect(aiConnectionInputFromForm(form({ ...base, displayName: " supa ", machine: "" })).input).toMatchObject({ displayName: "supa", machine: null });
    expect(aiConnectionInputFromForm(form({ ...base, displayName: "가".repeat(81) })).issues).toEqual(["ai_connection_invalid:displayName"]);
  });

  it("/models 읽기는 root 를 알려 줄 때만 담는다", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "supa", max_model_len: 131072, root: "Inferact/Qwen3.8-27B-NVFP4" }, { id: "plain" }] }),
      { status: 200, headers: { "content-type": "application/json" } }));
    expect(await readConnectionModels("https://supa.example/v1", null, request as unknown as typeof fetch)).toEqual({ ok: true, models: [
      { id: "supa", maxModelLen: 131072, root: "Inferact/Qwen3.8-27B-NVFP4" }, { id: "plain", maxModelLen: null }] });
  });
});

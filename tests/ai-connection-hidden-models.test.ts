import { describe, expect, it } from "vitest";
import { aiTaskModelSnapshotRows, cliDerivedRegistryKeys } from "@/lib/llm/ai-task-models-snapshot";
import { aiConnectionHiddenModels, aiConnectionVisibleModels } from "@/lib/operations/admin-ai-tasks";

/**
 * 2026-11-08 운영자 결정: 연결에서 「삭제」한 모델은 다른 관리 화면에서도 안 보인다. 관리 화면 보기(aiConnectionView)뿐 아니라 실행 스냅숏(순위 해석·검색 설정·
 * 등록부 파생 항목이 읽는 것)·장비 한도·검색 설정·응답 테스트가 같은 options.hiddenModels 로 거른다.
 */
const raw = (patch: Record<string, unknown>) => ({ task: "crawl-tagline", slot: 1, rank: 1, model: "gpt-oss-120b", enabled: true, options: {},
  connection_id: "11111111-1111-4111-8111-111111111111", label: "m3", kind: "api", base_url: "http://m3.test:8014/v1", api_key_ciphertext: null, cli_tool: null,
  device_id: "m3-mlx", connection_enabled: true, connection_options: {}, connection_version: 3, cli_models: [], capacity_slots: 1,
  models: [{ id: "gpt-oss-120b", maxModelLen: 131072 }, { id: "qwen3.6-35b-heretic", maxModelLen: null }], ...patch });

describe("삭제한 모델 거르기", () => {
  it("options.hiddenModels 는 문자열만·중복 없이 읽고, 목록에서 그 이름을 뺀다", () => {
    expect(aiConnectionHiddenModels({ hiddenModels: ["a", "a", 3, "", "b"] })).toEqual(["a", "b"]);
    expect(aiConnectionHiddenModels(null)).toEqual([]);
    expect(aiConnectionVisibleModels([{ id: "a" }, { id: "b" }, { id: "c" }], { hiddenModels: ["b"] })).toEqual([{ id: "a" }, { id: "c" }]);
    expect(aiConnectionVisibleModels(null, { hiddenModels: ["b"] })).toBeNull();
  });
  it("실행 스냅숏의 연결 목록도 삭제한 모델을 뺀다 — 순위가 쓰는 모델은 그대로", () => {
    const [row] = aiTaskModelSnapshotRows([raw({ connection_options: { hiddenModels: ["qwen3.6-35b-heretic"] } })]);
    expect(row.connection.models?.map(model => model.id)).toEqual(["gpt-oss-120b"]);
    const [plain] = aiTaskModelSnapshotRows([raw({})]);
    expect(plain.connection.models?.map(model => model.id)).toEqual(["gpt-oss-120b", "qwen3.6-35b-heretic"]);
  });
  it("CLI 연결의 노출 목록(cliModels)에서도 뺀다", () => {
    const [row] = aiTaskModelSnapshotRows([raw({ kind: "cli", cli_tool: "claude", models: null, cli_models: ["sonnet", "opus"], model: "sonnet",
      connection_options: { hiddenModels: ["opus"] } })]);
    expect(row.connection.cliModels).toEqual(["sonnet"]);
  });
  it("OpenCode 모델의 등록부 키는 추론 강도 × 경로마다 하나 — 같은 입력이면 같은 키", () => {
    const keys = cliDerivedRegistryKeys({ id: "22222222-2222-4222-8222-222222222222", deviceId: "m3-opencode-host" }, "opencode-go/deepseek-v4.1-flash", ["default", "high"]);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key).toMatch(/^m3-opencode-host:cli-[0-9a-f]{24}$/);
    expect(cliDerivedRegistryKeys({ id: "22222222-2222-4222-8222-222222222222", deviceId: "m3-opencode-host" }, "opencode-go/deepseek-v4.1-flash", ["high"])).toEqual(keys);
  });
});

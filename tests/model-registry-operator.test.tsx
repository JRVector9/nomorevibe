import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextModelStagesTable } from "@/app/(operator)/admin/models/TextModelStagesTable";
import { ModelRegistryTable } from "@/app/(operator)/admin/models/ModelRegistryTable";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { classificationDefaultConfig, classificationModelOptions, classificationModelProvider } from "@/lib/operations/classification-models";
import { modelConfigSchemaFor } from "@/lib/operations/contracts";
import { currentModelEnv } from "@/lib/operations/model-env";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

afterEach(() => { vi.unstubAllEnvs(); pinTextRanks(null); setServingContractSnapshotForTest(null); });

describe("configured operator model identities", () => {
  it("renders equipment keys and changed request/URL/resource settings from the server registry", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: [{ ...DEFAULT_MODEL_DEFINITIONS[2],
      model: "replacement", maxTokens: 2048, concurrency: 3, baseUrl: "https://replacement.example/v1" }] }) };
    const html = renderToStaticMarkup(createElement(ModelRegistryTable, { env }));
    for (const value of ["m1:translation", "[m1] replacement", "https://replacement.example/v1", "2,048", "로드 시 순서를 검증", "등록부 장비 표지", "직접 연결 행"]) expect(html).toContain(value);
    expect(html).not.toContain("qwen3.8-flash-next");
  });
  it("shows independent Korean tagline and query selections from each task's ranks", async () => {
    // PR B: text 경로의 모델은 「작업 ↔ 모델」 순위가 고른다 — 같은 환경변수(ABCLLM_MODEL)·등록부 선택을 나눠 쓰던 세 자리가 저마다의 순위를 보인다.
    // 등록부 선택·환경변수는 읽지 않는다
    vi.stubEnv("ABCLLM_MODEL", "env-translate");
    vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "m1:translation" ? { ...model, purposes: [...model.purposes, "product-tagline-ko", "search-query-translate"] } : model),
      selections: { "product-tagline-ko": "m1:translation", "search-query-translate": "m1:translation" } }));
    const second = { rank: 2, connectionId: "0b0c0d0e-0000-4000-8000-0000000000aa", baseUrl: "http://second.test:8000/v1", label: "second" };
    pinTextRanks([textRankRow("reason-translate", "gemma-4-26b"), textRankRow("product-tagline-ko", "gpt-oss-120b"),
      textRankRow("search-query-translate", "qwen3.6-35b"), textRankRow("search-query-translate", "qwen3.6-35b-backup", second),
      // 계약이 없는 순위는 부를 수 없어 담지 않는다
      textRankRow("crawl-tagline", "no-contract")]);
    setServingContractSnapshotForTest([textContract("reason-translate", "gemma-4-26b"), textContract("product-tagline-ko", "gpt-oss-120b"),
      textContract("search-query-translate", "qwen3.6-35b"), textContract("search-query-translate", "qwen3.6-35b-backup", { baseUrl: second.baseUrl })]);
    const models = await currentModelEnv();
    expect(models.translate).toBe("gemma-4-26b");
    expect(models.koreanTagline).toBe("gpt-oss-120b");
    expect(models.searchQuery).toBe("qwen3.6-35b");
    expect(models.pooled?.["search-query-translate"]).toEqual(["qwen3.6-35b", "qwen3.6-35b-backup"]);
    // 순위가 없거나 묶인 순위가 없는 자리는 빈 이름이다(기본값으로 채우지 않는다)
    expect([models.tagline, models.profile, models.verify, models.productTranslate]).toEqual(["", "", "", ""]);
    const html = renderToStaticMarkup(createElement(TextModelStagesTable, { models }));
    expect(html).toContain("한국어 소개 번역");
    expect(html).toContain("검색 질의 번역");
    for (const model of ["gemma-4-26b", "gpt-oss-120b", "qwen3.6-35b"]) expect(html).toContain(`>${model}</td>`);
    expect(html).not.toContain("env-translate");
    expect(html).not.toContain("[m1] mlx-community--gemma-4-26b-a4b-it-4bit");
  });
  it("keeps default CLI configuration valid when the primary provider changes", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "connect:spark" ? { ...model, model: "claude-primary", provider: "claude-cli" } : model) }) };
    const defaults = classificationDefaultConfig(env);
    expect(defaults.primary).toEqual({ model: "claude-primary", effort: "high" });
    expect(modelConfigSchemaFor(classificationModelOptions(env)).safeParse(defaults).success).toBe(true);
  });
  it("selects the CLI provider from configured metadata when its model alias changes", () => {
    const env = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model =>
      model.key === "connect:sonnet" ? { ...model, model: "claude-replacement", displayName: "Claude replacement" } : model) }) };
    const options = classificationModelOptions(env), schema = modelConfigSchemaFor(options);
    expect(classificationModelProvider("claude-replacement", env)).toBe("claude-cli");
    expect(options.find(option => option.model === "claude-replacement")?.displayName).toBe("Claude replacement");
    expect(schema.safeParse({ primary: { model: "claude-replacement", effort: "high" }, fallback: null }).success).toBe(true);
    expect(schema.safeParse({ primary: { model: "claude-replacement", effort: "xhigh" }, fallback: null }).success).toBe(false);
    expect(() => classificationModelProvider("sonnet", env)).toThrow("classification_model_not_configured");
  });
});

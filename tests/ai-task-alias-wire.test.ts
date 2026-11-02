import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { prepareCrawlTaglineGatewayCall, prepareReasonTranslationGatewayCall } from "@/lib/crawl/agent-review-gateway";
import { crawlTaglineGatewayWire, type TaglineEvidence } from "@/lib/crawl/tagline";
import { reasonTranslationGatewayWire } from "@/lib/crawl/translate";
import { aiTaskAliasIdentity } from "@/lib/llm/ai-tasks";
import { reasonTranslationServingContractHash, reasonTranslationServingContractSchema } from "@/lib/llm/reason-translation-serving-contract";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textContract } from "./text-task-ranks-fixture";

/**
 * 같은 모델 이름을 두 연결에 둔 순위(PR B) — 2순위는 연결로 가른 장부 이름(<모델>@<연결 id 앞 8자>)의 계약을 쓰고, 엔진에는 계약의 engineModel 이 나간다.
 * 장부·binding 의 model 은 장부 이름 그대로다(같은 요청의 identity 가 순위마다 갈린다). engineModel 이 없는 지금 계약의 hash 는 바뀌지 않는다.
 */
afterEach(() => setServingContractSnapshotForTest(null));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const alias = aiTaskAliasIdentity("Qwen-X", "0b0c0d0e-0000-4000-8000-0000000000aa")!;
const OTHER = "http://second.test:8000/v1";

it("사유 번역: 별칭 계약은 엔진 이름으로 wire 를 짓고, 장부 이름은 그대로 둔다", () => {
  setServingContractSnapshotForTest([textContract("reason-translate", "Qwen-X"), textContract("reason-translate", alias, { baseUrl: OTHER, engineModel: "Qwen-X" })]);
  const texts = ["Repository has no visible deployment evidence."];
  const call = prepareReasonTranslationGatewayCall(texts, { model: alias, timeoutMs: 10_000, provider: "abcllm" });
  expect(call.kind).toBe("prepared");
  if (call.kind !== "prepared") return;
  expect(call.model).toBe(alias);
  expect(call.wireHash).toBe(sha(reasonTranslationGatewayWire(texts, "Qwen-X")));
  expect(call.wireHash).not.toBe(sha(reasonTranslationGatewayWire(texts, alias)));
  const plain = prepareReasonTranslationGatewayCall(texts, { model: "Qwen-X", timeoutMs: 10_000, provider: "abcllm" });
  expect(plain.kind === "prepared" && plain.wireHash).toBe(sha(reasonTranslationGatewayWire(texts, "Qwen-X")));
  // 다른 서버의 같은 모델 계약이라 계약 hash 는 다르다(binding 이 어느 연결인지 묶는다)
  expect(plain.kind === "prepared" && plain.servingContractHash).not.toBe(call.servingContractHash);
});

it("수집 소개 짓기: 별칭 계약의 wire 도 엔진 이름이다", () => {
  setServingContractSnapshotForTest([textContract("crawl-tagline", alias, { baseUrl: OTHER, engineModel: "Qwen-X" })]);
  const evidence: TaglineEvidence = { name: "Doc", url: "https://doc.test", topics: [], language: null, pageTitle: "Doc", pageText: "Document manager", readme: "" };
  const call = prepareCrawlTaglineGatewayCall(evidence, { model: alias, timeoutMs: 10_000, provider: "abcllm" });
  expect(call.kind === "prepared" && call.wireHash).toBe(sha(crawlTaglineGatewayWire(evidence, "Qwen-X")));
});

it("engineModel 이 없는 계약은 parse 결과·hash 가 예전과 같다", () => {
  const { contract } = textContract("reason-translate", "Qwen-X");
  const parsed = reasonTranslationServingContractSchema.parse(contract);
  expect(Object.keys(parsed)).not.toContain("engineModel");
  expect(reasonTranslationServingContractHash(parsed)).toBe(sha(JSON.stringify(parsed)));
  expect(reasonTranslationServingContractSchema.safeParse({ ...(contract as object), engineModel: " bad" }).success).toBe(false);
});

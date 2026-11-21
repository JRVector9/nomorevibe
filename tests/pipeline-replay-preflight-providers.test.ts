import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { fixedInputPreflight } from "@/lib/operations/pipeline-replay-model-runner";
import { abcllmContract, contractRow, totalBoundContract } from "./total-bound-direct-fixture";

/**
 * 고정 입력 replay 의 실행 전 판정(2026-11-21 abcllm 이름표 정리 1단계): 심사자의 계약·장부 매핑을 abcllm 으로만 찾던 판정이 그 심사자의 provider 로 찾는다.
 * 장부의 게이트웨이 kind 로 서는 두 provider(abcllm 형 계약, 엔진 직접 local-direct 계약)만 받고 CLI 는 예전처럼 거절한다.
 */
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const UPSTREAM = "https://registry.example", ENDPOINT = `${UPSTREAM}/v1/chat/completions`;
const registry = { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1,
  models: DEFAULT_MODEL_DEFINITIONS.map(entry => entry.key === "supa:review" ? { ...entry, baseUrl: `${UPSTREAM}/v1` } : entry) }) };
type Reviewer = { provider: string; model: string };
function scene(voters: Reviewer[], routes: Reviewer[]) {
  const settings = JSON.parse(JSON.stringify(mergeWithDefaults({ enabled: true, reviewMode: "enforce", firstReview: { provider: "abcllm", model: "m" },
    secondReview: { enabled: true, voters, fallbacks: [], sampleRate: 0 } }))) as Record<string, unknown>;
  const artifact = { version: 1, scope: "fixed_input_replay", export: { revision: "abcdef1", exportedAt: "2026-10-17T00:00:00.000Z",
    from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", seed: "s", requested: 1, population: 1, examined: 1, selected: 1,
    exclusions: { modelChanged: 0, documentChanged: 0, scanChanged: 0, readmeMissing: 0, headroom: 0, inputDrift: 0, oversize: 0 },
    firstReviewer: { provider: "abcllm", model: "m" }, inputPolicyHash: sha256("policy") }, settings,
    inputs: [{ ordinal: 1, repo: "owner/repo", production: { candidateId: 7, attemptId: 9, inputHash: sha256("i"), decision: "approve",
      provider: "abcllm", model: "m" }, anchorAt: "2026-10-13T01:00:00.000Z", inputHash: sha256("i"),
      document: { repoMeta: {}, productUrl: "https://example.com", pageStatus: 200, pageMeta: { readmeSample: "# sample", readmeSampleVersion: README_SAMPLE_VERSION },
        fetchedAgeUs: 1_000_000 }, scan: null, observations: [] }] };
  const policy = { version: 1, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: "m", providerBudgetId: "unit", groupId: "unit" },
      ...routes.map(route => ({ routeId: "second-review", ...route, providerBudgetId: "unit", groupId: "unit" }))] };
  const manifest = { version: 1, runId: "items-a", mode: "items", artifactSha256: sha256("artifact"), upstream: UPSTREAM,
    durationMs: 1_800_000, limits: { maxCalls: 800, maxTokens: 800 * 32_768, perCallTokenUpperBound: 32_768, maxWallMs: 2_700_000 },
    items: { ai1Consumers: 1, ai2Consumers: 1, capacityPolicy: policy } };
  return { manifest, artifact };
}
const first = contractRow(abcllmContract("crawl-agent-review", { model: "m", endpoint: ENDPOINT }));
afterEach(() => setServingContractSnapshotForTest(null));

it("keeps today's abcllm reviewers runnable with their abcllm contracts and routes", () => {
  setServingContractSnapshotForTest([first, contractRow(abcllmContract("second-review", { model: "s", endpoint: ENDPOINT }))]);
  const { manifest, artifact } = scene([{ provider: "abcllm", model: "s" }], [{ provider: "abcllm", model: "s" }]);
  expect(fixedInputPreflight(manifest, artifact, registry).blocked).toEqual([]);
});

it("finds a local-direct voter's contract and capacity route by its own provider", () => {
  setServingContractSnapshotForTest([first, contractRow(totalBoundContract("second-review", { model: "s", endpoint: ENDPOINT }))]);
  const voters = [{ provider: "local-direct", model: "s" }];
  const mapped = scene(voters, [{ provider: "local-direct", model: "s" }]);
  expect(fixedInputPreflight(mapped.manifest, mapped.artifact, registry).blocked).toEqual([]);
  // 장부에 abcllm route 만 있으면 그 voter 는 줄에 설 수 없다 — 실행 전에 막는다
  const unmapped = scene(voters, [{ provider: "abcllm", model: "s" }]);
  expect(fixedInputPreflight(unmapped.manifest, unmapped.artifact, registry).blocked).toEqual(["ai2_capacity_route_unmapped"]);
  // 계약이 다른 provider 것이면(abcllm 계약뿐) local-direct voter 의 계약은 없다
  setServingContractSnapshotForTest([first, contractRow(abcllmContract("second-review", { model: "s", endpoint: ENDPOINT }))]);
  expect(fixedInputPreflight(mapped.manifest, mapped.artifact, registry).blocked).toEqual(["ai2_serving_contract_unavailable"]);
  // 엔진 주소가 upstream 밖이면 egress 관문이 막을 호출이다
  setServingContractSnapshotForTest([first, contractRow(totalBoundContract("second-review", { model: "s", endpoint: "https://elsewhere.example/v1/chat/completions" }))]);
  expect(fixedInputPreflight(mapped.manifest, mapped.artifact, registry).blocked).toEqual(["ai2_serving_endpoint_outside_upstream"]);
});

it("still refuses CLI reviewers", () => {
  setServingContractSnapshotForTest([first]);
  const { manifest, artifact } = scene([{ provider: "claude-cli", model: "opus" }], []);
  expect(() => fixedInputPreflight(manifest, artifact, registry)).toThrow("replay_cli_provider_unsupported");
});

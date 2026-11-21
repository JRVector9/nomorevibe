import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import "@/lib/crawl/agent-review-serving-contract";
import "@/lib/crawl/second-review-serving-contract";
import { CATEGORIES } from "@/lib/domain/products/schema";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";
import { CONTEXT_STRATEGY_ROUTES, comparePair, PRIVATE_ITEMS, itemsSimilarity, normalizeOutputText, parseShapeCompareArgs, planShapeCompare, runShapeCompare,
  SHAPE_COMPARE_LIMITS, shapeComparePlanLines, shapeCompareSummaryLines, STRICT_HEADER_ROUTES, summarizeShapeCompare, textSimilarity, wireFieldDiff,
  wireFieldDigest, type CallOutcome, type CallRecord, type CompareContractView, type CompareRoute, type CompareVariant, type ShapeCompareArgs,
  type ShapeCompareDeps } from "@/lib/operations/contract-shape-compare";
import { evaluateResponse, preparedWireHash, redactedText, variantHeaders, variantNeedsTokenizer, variantWire, type ParsedContract,
  type SampleInput } from "@/lib/operations/contract-shape-compare-routes";
import type { KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";
import { endpointHost, externalContract, koreanTaglineSampleBatches, privateHost, responseStop, ROUTE_JOBS, routeKillSwitch, routeRanks, shapeCompareCallers,
  shapeCompareContracts, type ContractContext, type RouteGates } from "@/lib/operations/contract-shape-compare-run";
import { totalBoundContractFromAbcllm } from "@/lib/operations/serving-contract-convert";
import { DEFAULT_CRAWL_SETTINGS, DEFAULT_CATEGORY_DEFINITIONS } from "@/lib/crawl/settings-schema";
import { runContractShapeCompare } from "@/scripts/ops/contract-shape-compare";
import { abcllmContract, classifyPayload, contractRow, prepareRouteCall, profileEvidence, queryInput, reasonTexts, reviewInput, taglineEvidence,
  taglineKoItems, TOTAL_BOUND_ROUTES, translationItems, verifyItem, type TotalBoundRoute } from "./total-bound-direct-fixture";

/**
 * 계약 모양 견줌(abcllm 이름표 정리 3단계 전, D-6) — 순수 규칙(인자·계획·견줌·요약), 가짜 deps 로 dry-run·실행 순서(네트워크 없음), 그리고 경로마다
 * 이 도구가 만드는 두 모양의 wire 가 실제 준비 함수의 바이트와 같고 둘의 차이가 context_strategy 하나뿐임(다섯 경로)을 본다. 운영 값이 아니다.
 */
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => { setServingContractSnapshotForTest(null); });

// ── fixture ───────────────────────────────────────────────────────────────────────────────────────────

/** 경로의 고정 입력(total-bound-direct-fixture 와 같은 것)을 이 도구의 표본 모양으로 */
function sampleFor(route: TotalBoundRoute): SampleInput {
  switch (route) {
    case "crawl-agent-review": case "second-review": return { kind: "review", input: reviewInput() };
    case "product-search-profile": return { kind: "profile", evidence: profileEvidence() };
    case "product-search-verify": return { kind: "verify", item: verifyItem() };
    case "crawl-tagline": return { kind: "crawl-tagline", evidence: taglineEvidence() };
    case "reason-translate": return { kind: "reasons", texts: reasonTexts() };
    case "product-translate": return { kind: "product-translate", items: translationItems(),
      sources: translationItems().map((item, index) => ({ id: index + 1, name: item.name, tagline: item.field === "tagline" ? item.text : "",
        description: item.field === "description" ? item.text : "" })) };
    case "product-tagline-ko": return { kind: "tagline-ko", items: taglineKoItems() };
    case "search-query-translate": return { kind: "query", input: queryInput() };
    case "crawl-publish-classify": return { kind: "classify", payload: classifyPayload() };
  }
}
const parsedAbcllm = (route: TotalBoundRoute, contract: Record<string, unknown>): ParsedContract => {
  const checked = validateAdminServingContract(route, contract);
  if (!checked.ok) throw new Error(`${route}:${checked.reason}`);
  return checked.contract;
};
const converted = (route: TotalBoundRoute, contract: Record<string, unknown>): ParsedContract => {
  const mapped = totalBoundContractFromAbcllm(route, contract);
  if (!mapped.ok) throw new Error(`${route}:${mapped.reason}`);
  return mapped.contract as ParsedContract;
};

const ARGS: ShapeCompareArgs = Object.freeze({ route: "product-search-profile", model: null, samples: 3, maxPerContract: 5, execute: false, json: false, out: null });
const view = (model: string, extra: Partial<CompareContractView> = {}): CompareContractView =>
  Object.freeze({ model, wireModel: model, host: "engine.test:8000", cliEngine: false, tokenizer: [], bound: true, external: false, singleSlot: false,
    delayMs: SHAPE_COMPARE_LIMITS.delayMs, ...extra });
const outcome = (extra: Partial<CallOutcome> = {}): CallOutcome => Object.freeze({ refused: null, status: 200, transportError: null, latencyMs: 1000,
  finishReason: "stop", usage: { input: 100, output: 20, total: 120, reasoning: null }, accepted: true, failure: null, decision: null, items: ["가계부 앱"],
  itemChecks: null, itemPassed: null, stop: null, wireHash: "h", wireBytes: 10, wireFields: { model: "m", messages: "x" }, headers: [], ...extra });
/** 계약 고르기 바깥 사정 — 기본은 모두 순위에 묶임·콕 집지 않음·429 없음·칸 모름 */
const context = (models: readonly string[], extra: Partial<ContractContext> = {}): ContractContext => ({ explicit: false, recent429: new Map(), slots: new Map(),
  ranks: { readable: true, bound: new Map(models.map(model => [model, { text: null, deviceId: "test-device" }])), disabled: new Set() }, ...extra });
const GATES: RouteGates = { contractsDb: true, mode: "open", fenceActive: true, jobPaused: false, ranksReadable: true, boundCount: 1, disabledCount: 0 };
const rec = (variant: CompareVariant, sample: string, extra: Partial<CallOutcome> = {}, contract = "model-a"): CallRecord =>
  Object.freeze({ ...outcome(extra), contract, sample, variant, order: variant === "abcllm" ? 1 : 2 });
/** 응답 검사 결과(Evaluation)를 기록 모양으로 채우는 나머지 칸 */
const outcomeTail = (variant: CompareVariant) => ({ refused: null, status: 200, transportError: null, latencyMs: 10, stop: null, wireHash: "h", wireBytes: 1,
  wireFields: null, headers: [], contract: "model-a", sample: "s", variant, order: variant === "abcllm" ? 1 as const : 2 as const });

// ── 인자 ───────────────────────────────────────────────────────────────────────────────────────────────

describe("parseShapeCompareArgs", () => {
  it("takes the route, model, sample count and the two flags, with five samples by default", () => {
    expect(parseShapeCompareArgs(["--route=second-review"])).toEqual({ route: "second-review", model: null, samples: 5, maxPerContract: 5, execute: false,
      json: false, out: null });
    expect(parseShapeCompareArgs(["--route=crawl-tagline", "--model=gpt-oss-120b@0b0c0d0e", "--samples=20", "--max-per-contract=20", "--execute", "--json",
      "--out=/tmp/x.json"])).toEqual({ route: "crawl-tagline", model: "gpt-oss-120b@0b0c0d0e", samples: 20, maxPerContract: 20, execute: true, json: true,
      out: "/tmp/x.json" });
  });
  it("refuses unknown routes, unknown or repeated options, empty values and out-of-range sample counts", () => {
    for (const argv of [[], ["--route=nope"], ["--route=crawl-tagline", "--samples=0"], ["--route=crawl-tagline", "--samples=21"],
      ["--route=crawl-tagline", "--samples=5x"], ["--route=crawl-tagline", "--execute", "--execute"], ["--route=crawl-tagline", "--model="],
      ["--route=crawl-tagline", "--model= padded"], ["--route=crawl-tagline", "--force"], ["--route=crawl-tagline", "--route=second-review"],
      ["--route=crawl-tagline", "--delay=0"], ["--route=crawl-tagline", "--max-per-contract=0"], ["--route=crawl-tagline", "--max-per-contract=21"]])
      expect(parseShapeCompareArgs(argv), JSON.stringify(argv)).toBeNull();
  });
});

// ── 계획 ───────────────────────────────────────────────────────────────────────────────────────────────

describe("planShapeCompare", () => {
  const samples = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `product:${index + 1}`, label: `p${index + 1}` }));
  it("counts samples × contracts × 2 chat calls and the tokenizer calls of tokenizer-backed variants", () => {
    const plan = planShapeCompare({ route: "second-review", model: null, samplesRequested: 5, refusals: [], killSwitch: null, samples: samples(5),
      contracts: [view("a", { tokenizer: ["abcllm", "total-bound"] }), view("b")] });
    expect(plan).toMatchObject({ chatCalls: 20, tokenizerCalls: 10, blocked: null });
    expect(plan.notes[0]).toContain("context_strategy");
  });
  it(`refuses more than ${SHAPE_COMPARE_LIMITS.maxCalls} chat calls and says how many samples per contract fit`, () => {
    const plan = planShapeCompare({ route: "crawl-agent-review", model: null, samplesRequested: 9, maxPerContract: 9, refusals: [], killSwitch: null, samples: samples(9),
      contracts: ["a", "b", "c", "d", "e"].map(name => view(name)) });
    expect(plan).toMatchObject({ chatCalls: 90, perContractSamples: 9, blocked: "call_cap_exceeded" });
    expect(plan.notes.join(" ")).toContain("--max-per-contract=8");
    const fits = planShapeCompare({ route: "crawl-agent-review", model: null, samplesRequested: 8, maxPerContract: 8, refusals: [], killSwitch: null, samples: samples(8),
      contracts: ["a", "b", "c", "d", "e"].map(name => view(name)) });
    expect(fits).toMatchObject({ chatCalls: 80, blocked: null });
  });
  it("caps each contract at 5 samples (10 calls) by default on top of the total cap", () => {
    const plan = planShapeCompare({ route: "crawl-agent-review", model: null, samplesRequested: 20, refusals: [], killSwitch: null, samples: samples(20),
      contracts: [view("a"), view("b")] });
    expect(plan).toMatchObject({ perContractSamples: 5, chatCalls: 20, blocked: null });
    expect(plan.notes.join(" ")).toContain("계약마다 표본 5건까지만");
    expect(planShapeCompare({ route: "crawl-agent-review", model: null, samplesRequested: 20, maxPerContract: 8, refusals: [], killSwitch: null,
      samples: samples(20), contracts: [view("a")] })).toMatchObject({ perContractSamples: 8, chatCalls: 16 });
  });
  it("blocks on a kill switch, no contracts or no samples, and notes fewer samples than asked", () => {
    const base = { route: "reason-translate" as const, model: null, samplesRequested: 5, refusals: [] };
    expect(planShapeCompare({ ...base, killSwitch: "capacity_draining", contracts: [view("a")], samples: samples(1) }).blocked).toBe("kill_switch:capacity_draining");
    expect(planShapeCompare({ ...base, killSwitch: null, contracts: [], samples: samples(1) }).blocked).toBe("no_contracts");
    expect(planShapeCompare({ ...base, killSwitch: null, contracts: [view("a")], samples: [] }).blocked).toBe("no_samples");
    const short = planShapeCompare({ ...base, killSwitch: null, contracts: [view("a")], samples: samples(2) });
    expect(short.blocked).toBeNull();
    // 번역 경로: 본문은 같고 엄격 terminal 헤더만 다르다
    expect(short.notes.join(" ")).toContain("X-Abcllm-Strict-Terminal");
    expect(short.notes.join(" ")).toContain("5건을 원했고 2건");
  });
});

// ── 견줌·요약 ─────────────────────────────────────────────────────────────────────────────────────────

describe("comparison", () => {
  it("normalizes text and scores character-bigram similarity, items by position", () => {
    expect(normalizeOutputText("  Expense  Tracker\n")).toBe("expense tracker");
    expect(textSimilarity("Expense tracker", "expense   TRACKER")).toBe(1);
    expect(textSimilarity("가계부 앱", "가계부 앱이다")).toBeGreaterThan(0.7);
    expect(textSimilarity("가계부", "달력")).toBe(0);
    expect(textSimilarity("a", "b")).toBe(0);
    expect(itemsSimilarity(["a b", "c d"], ["a b"])).toBe(0.5);
    expect(itemsSimilarity([], [])).toBe(1);
  });

  it("agrees on the same decision for review routes and on similar valid text for text routes", () => {
    const decision = comparePair("crawl-agent-review", rec("abcllm", "candidate:1", { decision: "approve" }), rec("total-bound", "candidate:1", { decision: "reject" }));
    expect(decision).toMatchObject({ mode: "decision", bothAccepted: true, sameDecision: false, agree: false });
    expect(comparePair("crawl-agent-review", rec("abcllm", "c", { decision: "approve", items: ["x"] }), rec("total-bound", "c", { decision: "approve", items: ["y"] })))
      .toMatchObject({ sameDecision: true, agree: true, exactSame: false });
    const text = comparePair("product-search-profile", rec("abcllm", "p", { items: ["가계부 앱 · 지출 관리"] }), rec("total-bound", "p", { items: ["가계부 앱 · 지출 관리"] }));
    expect(text).toMatchObject({ mode: "text", agree: true, exactSame: true, similarity: 1, sameDecision: null });
    const failed = comparePair("product-search-profile", rec("abcllm", "p"), rec("total-bound", "p", { accepted: false, failure: "invalid_output", items: [] }));
    expect(failed).toMatchObject({ agree: false, bothAccepted: false, sameAcceptance: false, similarity: null });
    // wire 칸 차이와 헤더 차이(abcllm → 새 모양)
    const diff = comparePair("reason-translate", rec("abcllm", "r", { wireFields: { context_strategy: "c", model: "m" }, headers: ["X-Abcllm-Strict-Terminal"] }),
      rec("total-bound", "r", { wireFields: { model: "m" } }));
    expect(diff).toMatchObject({ wireDiff: ["context_strategy"], headerDiff: ["-X-Abcllm-Strict-Terminal"] });
    expect(() => comparePair("reason-translate", rec("total-bound", "r"), rec("abcllm", "r"))).toThrow("shape_compare_pair_mismatch");
  });

  it("summarizes per contract: agreement, failures per variant, latency/usage deltas, wire diffs and truncated disagreement examples", () => {
    const long = "가".repeat(400);
    const records = [
      rec("abcllm", "candidate:1", { decision: "approve", items: ["ok"], latencyMs: 1000, usage: { input: 100, output: 40, total: 140, reasoning: 10 },
        wireFields: { context_strategy: "c", model: "m" } }),
      rec("total-bound", "candidate:1", { decision: "approve", items: ["ok"], latencyMs: 800, usage: { input: 98, output: 30, total: 128, reasoning: 8 },
        wireFields: { model: "m" } }),
      rec("abcllm", "candidate:2", { decision: "approve", items: [long], latencyMs: 3000, usage: { input: 100, output: 60, total: 160, reasoning: null } }),
      rec("total-bound", "candidate:2", { decision: "reject", items: [long], latencyMs: 1200, usage: { input: 100, output: 50, total: 150, reasoning: null } }),
      rec("abcllm", "candidate:3", { accepted: false, failure: "invalid_output:invalid_json", decision: null, items: [], latencyMs: 2000, usage: null }),
      rec("total-bound", "candidate:3", { refused: "wire_mismatch", status: null, latencyMs: null, accepted: false, decision: null, items: [], usage: null }),
    ];
    const summary = summarizeShapeCompare("crawl-agent-review", [view("model-a", { host: "engine.test:8010" })], records);
    const [contract] = summary.contracts;
    expect(contract).toMatchObject({ contract: "model-a", host: "engine.test:8010", pairs: 3, agree: 1, agreementRate: 0.333, bothAccepted: 2, bothSent: 2 });
    expect(contract.variants.abcllm).toMatchObject({ calls: 3, sent: 3, accepted: 2, failures: { "invalid_output:invalid_json": 1 }, latencyMedianMs: 2000 });
    expect(contract.variants["total-bound"]).toMatchObject({ calls: 3, sent: 2, accepted: 2, refused: { wire_mismatch: 1 }, latencyMedianMs: 1000 });
    expect(contract.deltas).toEqual({ latencyMedianMs: -1000, outputTokensMean: -10, totalTokensMean: -11 });
    expect(contract.wireDiffs).toMatchObject({ context_strategy: 1, "(같음)": 2 });
    expect(contract.examples.map(example => example.sample)).toEqual(["candidate:2", "candidate:3"]);
    expect(Array.from(contract.examples[0].abcllm).length).toBeLessThanOrEqual(SHAPE_COMPARE_LIMITS.exampleChars + 1);
    expect(contract.examples[1]).toMatchObject({ abcllm: "실패(invalid_output:invalid_json)", totalBound: "보내지 않음(wire_mismatch)" });
    expect(summary.overall).toMatchObject({ pairs: 3, agree: 1, calls: 6, sent: 5, accepted: { abcllm: 2, "total-bound": 2 } });
    const lines = shapeCompareSummaryLines({ version: 1, route: "crawl-agent-review", model: null, execute: true, startedAt: "", finishedAt: "",
      plan: planShapeCompare({ route: "crawl-agent-review", model: null, samplesRequested: 3, refusals: [], killSwitch: null,
        contracts: [view("model-a", { host: "engine.test:8010" })], samples: [1, 2, 3].map(id => ({ id: `candidate:${id}`, label: "" })) }),
      previews: [], records, pairs: [], stops: [], summary });
    expect(lines.join("\n")).toContain("일치 1/3(33%, 같은 판정)");
    expect(lines.join("\n")).toContain("지연 중앙 abcllm 2.0초 · 새 모양 1.0초 (-1.0초)");
  });

  it("digests wire fields without carrying the bytes and diffs them by top-level key", () => {
    const a = wireFieldDigest(JSON.stringify({ context_strategy: "raw", model: "m", messages: [{ role: "user", content: "secret evidence" }] }));
    const b = wireFieldDigest(JSON.stringify({ model: "m", messages: [{ role: "user", content: "secret evidence" }] }));
    expect(JSON.stringify(a)).not.toContain("secret evidence");
    expect(wireFieldDiff(a, b)).toEqual(["context_strategy"]);
    expect(wireFieldDigest("not json")).toBeNull();
    expect(wireFieldDiff(null, b)).toBeNull();
  });
});

// ── 실행 순서(가짜 deps, 네트워크 없음) ─────────────────────────────────────────────────────────────

function fakeDeps(options: { contracts?: CompareContractView[]; samples?: number; killSwitch?: string | null;
  respond?: (contract: string, index: number, variant: CompareVariant) => Partial<CallOutcome> } = {}) {
  const calls: { contract: string; sample: string; variant: CompareVariant; start: number; end: number }[] = [];
  const previews: string[] = [], sleeps: number[] = [];
  let clock = 0, running = 0, overlapped = false;
  const deps: ShapeCompareDeps = {
    now: () => new Date(Date.UTC(2026, 10, 21, 0, 0, clock)),
    sleep: async ms => { sleeps.push(ms); clock++; },
    load: async () => ({ contracts: options.contracts ?? [view("model-a"), view("model-b", { host: "other.test:8014" })],
      refusals: [{ model: "model-c", host: "gw.test:9000", reason: "transport_not_direct", detail: null }],
      samples: Array.from({ length: options.samples ?? 3 }, (_, index) => ({ id: `product:${index + 1}`, label: `p${index + 1}` })),
      killSwitch: options.killSwitch ?? null }),
    preview: async (contract, sample) => { previews.push(`${contract}|${sample}`); return { contract, sample, check: "ok", wireDiff: ["context_strategy"], headerDiff: [] }; },
    call: async (contract, sample, variant) => {
      if (running) overlapped = true;
      running++;
      const start = clock++;
      await Promise.resolve();
      running--;
      calls.push({ contract, sample, variant, start, end: clock });
      return outcome({ items: ["가계부 앱"], ...options.respond?.(contract, calls.filter(call => call.contract === contract).length, variant) });
    },
  };
  return { deps, calls, previews, sleeps, overlapped: () => overlapped };
}

describe("runShapeCompare", () => {
  it("dry-run calls nothing: it previews the first sample of each contract and prints contracts by model and host only", async () => {
    const fake = fakeDeps();
    const report = await runShapeCompare(ARGS, fake.deps);
    expect(fake.calls).toEqual([]);
    expect(fake.previews).toEqual(["model-a|product:1", "model-b|product:1"]);
    expect(report).toMatchObject({ execute: false, records: [], summary: null, plan: { chatCalls: 12, blocked: null } });
    const lines = shapeComparePlanLines(report).join("\n");
    expect(lines).toContain("dry-run(부르지 않음)");
    expect(lines).toContain("계약 model-a @ engine.test:8000");
    expect(lines).toContain("제외 model-c @ gw.test:9000: transport_not_direct");
    expect(lines).toContain("표본: product:1, product:2, product:3");
    expect(lines).toContain("미리 보기 model-a · product:1: ok · wire 칸 차이 context_strategy");
    expect(lines).not.toMatch(/https?:\/\//);
  });

  it("--execute sends samples × contracts × 2 calls one at a time with a delay between, alternating which shape goes first", async () => {
    const fake = fakeDeps();
    const report = await runShapeCompare({ ...ARGS, execute: true }, fake.deps);
    expect(fake.calls).toHaveLength(12);
    expect(fake.overlapped()).toBe(false);
    expect(fake.sleeps).toEqual(Array(11).fill(SHAPE_COMPARE_LIMITS.delayMs));
    expect(fake.calls.slice(0, 6).map(call => `${call.sample}:${call.variant}`)).toEqual(["product:1:abcllm", "product:1:total-bound",
      "product:2:total-bound", "product:2:abcllm", "product:3:abcllm", "product:3:total-bound"]);
    expect(report.records.map(record => record.order)).toEqual([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    expect(report.pairs).toHaveLength(6);
    expect(report.summary?.overall).toMatchObject({ pairs: 6, agree: 6, calls: 12 });
    expect(report.previews).toEqual([]);
  });

  it("--execute calls nothing when the plan is blocked (kill switch or call cap)", async () => {
    const killed = fakeDeps({ killSwitch: "crawl_disabled" });
    expect(await runShapeCompare({ ...ARGS, execute: true }, killed.deps)).toMatchObject({ execute: false, records: [], plan: { blocked: "kill_switch:crawl_disabled" } });
    expect(killed.calls).toEqual([]);
    expect(killed.previews).toEqual([]);
    const capped = fakeDeps({ samples: 20, contracts: [view("a"), view("b"), view("c")] });
    expect(await runShapeCompare({ ...ARGS, samples: 20, maxPerContract: 20, execute: true }, capped.deps)).toMatchObject({ plan: { chatCalls: 120,
      blocked: "call_cap_exceeded" } });
    expect(capped.calls).toEqual([]);
  });

  it("the script exits 2 on bad arguments, 3 when blocked, 0 otherwise, and prints JSON without keys", async () => {
    const out: string[] = [], err: string[] = [];
    expect(await runContractShapeCompare(["--route=nope"], line => out.push(line), line => err.push(line), fakeDeps().deps)).toBe(2);
    expect(err[0]).toContain("usage:");
    expect(await runContractShapeCompare(["--route=product-search-profile"], line => out.push(line), line => err.push(line),
      fakeDeps({ killSwitch: "serving_contracts_db_off" }).deps)).toBe(3);
    out.length = 0;
    expect(await runContractShapeCompare(["--route=product-search-profile", "--json", "--execute", "--samples=2"], line => out.push(line), () => {},
      fakeDeps({ samples: 2 }).deps)).toBe(0);
    const report = JSON.parse(out[0]);
    expect(report).toMatchObject({ version: 1, route: "product-search-profile", execute: true });
    expect(report.records).toHaveLength(8);
    expect(out[0]).not.toMatch(/Bearer|apiKey|https?:\/\//);
  });

  it("--out writes the report and a per-call JSONL journal as 0600, even over an existing world-readable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shape-compare-")), file = join(dir, "report.json");
    try {
      await writeFile(file, "{}\n", { mode: 0o644 }); await chmod(file, 0o644);
      await writeFile(`${file}.jsonl`, "old\n", { mode: 0o644 }); await chmod(`${file}.jsonl`, 0o644);
      const out: string[] = [];
      expect(await runContractShapeCompare(["--route=product-search-profile", "--execute", "--samples=2", `--out=${file}`], line => out.push(line), () => {},
        fakeDeps({ samples: 2, respond: (contract, index) => contract === "model-b" && index === 1 ? { stop: "rate_limited", status: 429 } : {} }).deps)).toBe(0);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(`${file}.jsonl`)).mode & 0o777).toBe(0o600);
      const lines = (await readFile(`${file}.jsonl`, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string });
      expect(lines.map(line => line.type)).toEqual(["plan", "record", "record", "record", "record", "record", "stop"]);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, stops: [{ contract: "model-b", reason: "rate_limited" }] });
      expect(out.at(-1)).toContain(`${file}.jsonl`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// ── 엔진·외부 API 보호 ────────────────────────────────────────────────────────────────────────────────

describe("stop conditions", () => {
  const two = [view("model-a"), view("model-b", { host: "other.test:8014" })];
  it.each([
    ["rate_limited", { status: 429, accepted: false, failure: "http_429", stop: "rate_limited" }],
    ["retry_after", { status: 503, accepted: false, failure: "http_503", stop: "retry_after" }],
    ["quota_exhausted", { stop: "quota_exhausted" }],
  ] as const)("stops a contract on its first %s answer, records why and continues with the other contracts", async (reason, reply) => {
    const fake = fakeDeps({ contracts: two, samples: 5, respond: (contract, index) => contract === "model-a" && index === 2 ? reply : {} });
    const report = await runShapeCompare({ ...ARGS, samples: 5, execute: true }, fake.deps);
    expect(fake.calls.filter(call => call.contract === "model-a")).toHaveLength(2);
    expect(fake.calls.filter(call => call.contract === "model-b")).toHaveLength(10);
    expect(report.stops).toEqual([{ contract: "model-a", reason, afterCalls: 2, skippedCalls: 8 }]);
    expect(report.summary?.contracts.find(contract => contract.contract === "model-a")?.stopped).toMatchObject({ reason });
    expect(report.summary?.overall.stopped).toBe(1);
    expect(shapeCompareSummaryLines(report).join("\n")).toContain("남은 8회는 보내지 않았다");
  });
  it("stops after two consecutive timeouts, transport errors or 5xx engine failures, and a good answer resets the count", async () => {
    const failing = fakeDeps({ contracts: two, respond: (contract, index) => contract !== "model-a" ? {}
      : index === 1 ? { status: null, transportError: "timeout", accepted: false, failure: "timeout" }
      : index === 2 ? { status: 503, accepted: false, failure: "http_503" } : {} });
    const report = await runShapeCompare({ ...ARGS, execute: true }, failing.deps);
    expect(report.stops).toEqual([{ contract: "model-a", reason: "consecutive_failures", afterCalls: 2, skippedCalls: 4 }]);
    expect(failing.calls.filter(call => call.contract === "model-b")).toHaveLength(6);
    const recovering = fakeDeps({ contracts: [view("model-a")], respond: (_contract, index) => index % 2 === 1
      ? { status: null, transportError: "network", accepted: false, failure: "network" } : {} });
    const kept = await runShapeCompare({ ...ARGS, execute: true }, recovering.deps);
    expect(kept.stops).toEqual([]);
    expect(recovering.calls).toHaveLength(6);
  });
  it("waits longer between calls to a single-slot engine", async () => {
    const fake = fakeDeps({ contracts: [view("model-a", { singleSlot: true, delayMs: SHAPE_COMPARE_LIMITS.singleSlotDelayMs })], samples: 2 });
    await runShapeCompare({ ...ARGS, samples: 2, execute: true }, fake.deps);
    expect(fake.sleeps).toEqual([2000, 2000, 2000]);
  });
  it("reads the stop signals from the engine response: 429, Retry-After(-ms) and a verified zero remaining quota", () => {
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(responseStop(429, headers({}))).toBe("rate_limited");
    expect(responseStop(503, headers({ "Retry-After": "30" }))).toBe("retry_after");
    expect(responseStop(200, headers({ "retry-after-ms": "500" }))).toBe("retry_after");
    expect(responseStop(200, headers({ "x-minute-rate-limit": "10", "x-minute-rate-limit-remaining": "0" }))).toBe("quota_exhausted");
    expect(responseStop(200, headers({ "x-minute-rate-limit": "10", "x-minute-rate-limit-remaining": "3" }))).toBeNull();
    expect(responseStop(200, headers({}))).toBeNull();
  });
});

describe("default exclusions", () => {
  const rows = (models: readonly string[], extra: Record<string, Record<string, unknown>> = {}) => models.map(model =>
    contractRow(abcllmContract("product-tagline-ko", { model, ...(extra[model] ?? {}) })));
  it("tells private and tailnet hosts from external ones", () => {
    for (const host of ["10.1.2.3", "172.16.0.1", "192.168.1.9", "127.0.0.1", "100.64.0.1", "100.127.255.254", "169.254.1.1", "::1", "fd00::1", "fe80::1",
      "localhost", "m3-ultra", "gpu.tail1234.ts.net", "engine.internal", "box.local", "nas.lan", "x.home.arpa", "engine.test"]) expect(privateHost(host), host).toBe(true);
    for (const host of ["8.8.8.8", "100.128.0.1", "172.32.0.1", "api.exaone.ai", "engine.example.com", "2001:4860::8888"]) expect(privateHost(host), host).toBe(false);
    expect(externalContract({ endpoint: "http://100.64.0.1:8010/v1/chat/completions" })).toBeNull();
    expect(externalContract({ endpoint: "https://api.example.com/v1/chat/completions" })).toBe("public_host");
    expect(externalContract({ endpoint: "http://100.64.0.1:8010/v1/chat/completions", rateLimitBackoff: { initialBackoffMs: 60_000, maxBackoffMs: 600_000 } }))
      .toBe("rate_limit_backoff");
  });
  it("excludes external-API and rank-less contracts unless named with --model, and never calls disabled-rank or recently-429 contracts", () => {
    const external = { endpoint: "https://api.example.com/v1/chat/completions" };
    const backoff = { extra: { rateLimitBackoff: { initialBackoffMs: 60_000, maxBackoffMs: 600_000, honorQuotaHeaders: true } } };
    const all = rows(["bound", "stale", "exaone", "quota", "off", "limited", "single"], { exaone: external, quota: backoff });
    const ctx = context(["bound", "exaone", "quota", "limited", "single"], { recent429: new Map([["limited", 7]]), slots: new Map([["single", 1], ["bound", 3]]) });
    const withOff: ContractContext = { ...ctx, ranks: { ...ctx.ranks, disabled: new Set(["off"]) } };
    const plain = shapeCompareContracts("product-tagline-ko", null, all, withOff);
    expect(plain.contracts.map(contract => [contract.view.model, contract.view.singleSlot, contract.view.delayMs])).toEqual([
      ["bound", false, SHAPE_COMPARE_LIMITS.delayMs], ["single", true, SHAPE_COMPARE_LIMITS.singleSlotDelayMs]]);
    expect(plain.refusals.map(refusal => [refusal.model, refusal.reason])).toEqual([["exaone", "external_api"], ["limited", "recent_429"],
      ["off", "rank_disabled"], ["quota", "external_api"], ["stale", "not_in_ranks"]]);
    expect(plain.refusals.find(refusal => refusal.model === "exaone")?.detail).toContain("--model");
    // --model 로 콕 집으면 순위 밖·외부 API 는 들어오고(보이는 표시와 함께), 꺼진 순위·최근 429 는 여전히 빠진다
    const pick = (model: string) => shapeCompareContracts("product-tagline-ko", model, all, { ...withOff, explicit: true });
    expect(pick("exaone").contracts.map(contract => contract.view)).toMatchObject([{ model: "exaone", external: true, bound: true }]);
    expect(pick("quota").contracts.map(contract => contract.view)).toMatchObject([{ model: "quota", external: true }]);
    expect(pick("stale").contracts.map(contract => contract.view)).toMatchObject([{ model: "stale", bound: false }]);
    expect(pick("off").refusals.map(refusal => refusal.reason)).toEqual(["rank_disabled"]);
    expect(pick("limited").refusals.map(refusal => refusal.reason)).toEqual(["recent_429"]);
    const plan = planShapeCompare({ route: "product-tagline-ko", model: "stale", samplesRequested: 1, refusals: [], killSwitch: null,
      contracts: pick("stale").contracts.map(contract => contract.view), samples: [{ id: "s", label: "" }] });
    expect(plan.notes.join(" ")).toContain("묶이지 않은 계약을 --model 로 콕 집어 부른다: stale");
  });
  it("binds contracts to the current enabled ranks and lists the ones only disabled ranks point at", () => {
    const other = "0b0c0d0e-0000-4000-8000-000000000002", otherBase = "http://other.test:8000/v1";
    setServingContractSnapshotForTest([textContract("product-translate", "a-model"), textContract("product-translate", "b-model", { baseUrl: otherBase }),
      textContract("product-translate", "c-model", { baseUrl: "http://third.test:8000/v1" })]);
    pinTextRanks([textRankRow("product-translate", "a-model"), textRankRow("product-translate", "b-model", { rank: 2, connectionId: other, baseUrl: otherBase,
      enabled: false })]);
    try {
      const ranks = routeRanks("product-translate");
      expect(ranks.readable).toBe(true);
      expect([...ranks.bound.keys()]).toEqual(["a-model"]);
      expect(ranks.bound.get("a-model")?.text).toMatchObject({ identity: "a-model", provider: "abcllm" });
      expect([...ranks.disabled]).toEqual(["b-model"]);
    } finally { pinTextRanks(null); }
  });
});

describe("item-checked and private outputs", () => {
  it("counts a Korean-tagline or product-translation pair as agreeing only when every item passes the route's checker on both sides", () => {
    const passing = rec("abcllm", "p", { items: ["문서를 빠르게 정리해요", "릴리스를 함께 계획해요"], itemPassed: [true, true], itemChecks: { passed: 2, total: 2 } });
    const alsoPassing = rec("total-bound", "p", { items: ["문서를 빠르게 정리해요", "릴리스를 함께 계획해요"], itemPassed: [true, true] });
    const oneFails = rec("total-bound", "p", { items: ["문서를 빠르게 정리해요", "릴리스를 함께 계획해요"], itemPassed: [true, false] });
    expect(comparePair("product-tagline-ko", passing, alsoPassing)).toMatchObject({ agree: true, allItemsPassed: true });
    expect(comparePair("product-tagline-ko", passing, oneFails)).toMatchObject({ agree: false, allItemsPassed: false, similarity: 1 });
    expect(comparePair("product-translate", passing, oneFails)).toMatchObject({ agree: false });
    // 항목 검사가 없는 글 경로는 예전 규칙 그대로
    expect(comparePair("reason-translate", passing, oneFails)).toMatchObject({ agree: true, allItemsPassed: null });
  });
  it("records search-query translations as hash and length only and compares the real text in memory", async () => {
    const contract = converted("search-query-translate", abcllmContract("search-query-translate")), sample = sampleFor("search-query-translate");
    const wire = await variantWire("search-query-translate", contract, sample);
    const body = (content: string) => JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1, model: "served-fixture",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    const a = await evaluateResponse("search-query-translate", contract, wire, sample, 200, body("household budget app"));
    const b = await evaluateResponse("search-query-translate", contract, wire, sample, 200, body("household budget apps"));
    expect(a.items).toEqual([redactedText("household budget app")]);
    expect(a.items[0]).toMatch(/^sha256:[0-9a-f]{12}·20자$/);
    expect(a[PRIVATE_ITEMS]).toEqual(["household budget app"]);
    expect(JSON.stringify(a)).not.toContain("household");
    const pair = comparePair("search-query-translate", { ...a, ...outcomeTail("abcllm") }, { ...b, ...outcomeTail("total-bound") });
    expect(pair.similarity).toBeGreaterThan(0.9);
    expect(pair).toMatchObject({ agree: true, exactSame: false });
  });
  it("never puts one product in two Korean-tagline samples, even when the packer skips long or solo-retry items", () => {
    const task = (productId: number, extra: Partial<KoreanTaglineTask> = {}): KoreanTaglineTask => ({ productId, name: `P${productId}`, tagline: "Organize documents",
      repoUrl: null, attempts: 0, lastError: null, qualityRejections: 0, ...extra });
    const tasks = [task(1, { tagline: "x".repeat(1_300) }), task(2, { attempts: 99 }), task(3), task(4), task(5, { attempts: 99 }), task(6)];
    const batches = koreanTaglineSampleBatches(tasks, 10);
    const ids = batches.flat().map(entry => entry.productId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([2, 3, 4, 5, 6]);
    expect(koreanTaglineSampleBatches(tasks, 1)).toHaveLength(1);
  });
});

// ── 계약 고르기·꺼짐 ──────────────────────────────────────────────────────────────────────────────────

describe("contract selection and kill switches", () => {
  const stored = (contract: Record<string, unknown>, extra: Partial<StoredServingContract> = {}): StoredServingContract =>
    ({ ...contractRow(contract), auth: "stored", apiKey: "k".repeat(40), ...extra });
  it("compares enabled direct abcllm contracts and refuses the rest with a reason, showing host:port only", () => {
    const endpoint = "https://user:pass@engine.test:8443/v1/chat/completions";
    expect(endpointHost(endpoint)).toBe("engine.test:8443");
    const second = abcllmContract("second-review", { model: "budget", extra: { requestBudget: { requestTokenBound: 32_000, maxOutputTokens: 4096,
      tokenizerEndpoint: "http://engine.test:8000/tokenize", tokenizerModel: "budget" } } });
    const rows = [stored(abcllmContract("second-review", { model: "a-model" })), stored(second),
      stored(abcllmContract("second-review", { model: "gateway-row" }), { transport: "gateway" }),
      stored(abcllmContract("second-review", { model: "gateway-auth" }), { auth: "gateway" }),
      stored({ ...abcllmContract("second-review", { model: "already" }), provider: "local-direct", protocol: "openai-chat-total-bound-v1" }),
      stored(abcllmContract("crawl-tagline", { model: "other-route" }))];
    const all = context(["a-model", "budget", "gateway-row", "gateway-auth", "already"]);
    const { contracts, refusals } = shapeCompareContracts("second-review", null, rows, all);
    const base = { cliEngine: false, bound: true, external: false, singleSlot: false, delayMs: SHAPE_COMPARE_LIMITS.delayMs };
    expect(contracts.map(contract => contract.view)).toEqual([
      { model: "a-model", wireModel: "a-model", host: "engine.test:8000", tokenizer: [], ...base },
      { model: "budget", wireModel: "budget", host: "engine.test:8000", tokenizer: ["abcllm", "total-bound"], ...base }]);
    expect(refusals.map(refusal => [refusal.model, refusal.reason])).toEqual([["already", "not_abcllm"], ["gateway-auth", "auth_gateway"],
      ["gateway-row", "transport_not_direct"]]);
    expect(JSON.stringify({ views: contracts.map(contract => contract.view), refusals })).not.toContain("k".repeat(40));
    expect(shapeCompareContracts("second-review", "budget", rows, all).contracts.map(contract => contract.view.model)).toEqual(["budget"]);
  });
  it("respects the routes' own off switches, job pause, disabled or unreadable ranks, the DR fence and the deploy-window drain", () => {
    const settings = DEFAULT_CRAWL_SETTINGS;
    expect(routeKillSwitch("product-search-profile", settings, { ...GATES, contractsDb: false })).toBe("serving_contracts_db_off");
    expect(routeKillSwitch("product-search-profile", settings, { ...GATES, fenceActive: false })).toBe("dr_fenced");
    expect(routeKillSwitch("product-search-profile", settings, { ...GATES, mode: "draining" })).toBe("capacity_draining");
    expect(routeKillSwitch("product-search-profile", { ...settings, enabled: false }, GATES)).toBeNull();
    expect(routeKillSwitch("crawl-tagline", { ...settings, enabled: false }, GATES)).toBe("crawl_disabled");
    expect(routeKillSwitch("crawl-agent-review", { ...settings, enabled: true, reviewMode: "off" }, GATES)).toBe("review_off");
    expect(routeKillSwitch("second-review", { ...settings, enabled: true, secondReview: { ...settings.secondReview, enabled: false } }, { ...GATES, mode: "disabled" }))
      .toBe("second_review_off");
    expect(routeKillSwitch("product-translate", settings, { ...GATES, jobPaused: true })).toBe("job_paused");
    expect(routeKillSwitch("product-translate", settings, { ...GATES, ranksReadable: false })).toBe("ranks_unreadable");
    expect(routeKillSwitch("product-translate", settings, { ...GATES, boundCount: 0, disabledCount: 2 })).toBe("ranks_disabled");
    expect(routeKillSwitch("product-translate", settings, { ...GATES, boundCount: 0, disabledCount: 0 })).toBeNull();
    expect(routeKillSwitch("crawl-agent-review", { ...settings, enabled: true, reviewMode: "enforce" }, GATES)).toBeNull();
    expect(ROUTE_JOBS["crawl-publish-classify"]).toBe("crawl-publish");
    expect(ROUTE_JOBS["search-query-translate"]).toBeNull();
  });
});

// ── wire: 실제 준비 함수와 같은 바이트, 차이는 context_strategy 하나(다섯 경로) ─────────────────────────

describe.each(TOTAL_BOUND_ROUTES)("%s wire", route => {
  it("builds both shapes' bytes exactly as the route's prepare does and they differ only by context_strategy (D-6)", async () => {
    for (const extra of [{}, { engineModel: "engine-name" }] as Record<string, unknown>[]) {
      const model = extra.engineModel ? "engine-name@0b0c0d0e" : "fixture-model", label = JSON.stringify(extra);
      const stored = abcllmContract(route, { model, extra });
      const before = parsedAbcllm(route, stored), after = converted(route, stored), sample = sampleFor(route);
      const [oldWire, newWire] = [await variantWire(route, before, sample), await variantWire(route, after, sample)];
      // 실제 준비 함수(시험 fixture 의 prepareRouteCall)와 이 도구의 준비 어댑터(preparedWireHash)가 같은 바이트를 묶는다
      setServingContractSnapshotForTest([contractRow(stored)]);
      const old = await prepareRouteCall(route, model, "abcllm");
      if (old.kind !== "prepared") throw new Error(`${route}:abcllm:${old.reason}`);
      expect(sha(oldWire), label).toBe(old.wireHash);
      expect(await preparedWireHash(route, model, "abcllm", sample, 5_000), label).toEqual({ wireHash: old.wireHash });
      setServingContractSnapshotForTest([contractRow(after as Record<string, unknown>)]);
      const next = await prepareRouteCall(route, model, "local-direct");
      if (next.kind !== "prepared") throw new Error(`${route}:local-direct:${next.reason}`);
      expect(sha(newWire), label).toBe(next.wireHash);
      expect(await preparedWireHash(route, model, "local-direct", sample, 5_000), label).toEqual({ wireHash: next.wireHash });
      // 두 wire 의 차이: 다섯 경로는 context_strategy 하나(나머지 칸의 값·순서 그대로), 나머지 다섯은 바이트까지 같다
      const diff = wireFieldDiff(wireFieldDigest(oldWire), wireFieldDigest(newWire));
      if (CONTEXT_STRATEGY_ROUTES.has(route as CompareRoute)) {
        expect(diff, label).toEqual(["context_strategy"]);
        const oldBody = JSON.parse(oldWire) as Record<string, unknown>;
        expect(oldBody.context_strategy, label).toBe("raw");
        delete oldBody.context_strategy;
        expect(newWire, label).toBe(JSON.stringify(oldBody));
      } else {
        expect(diff, label).toEqual([]);
        expect(newWire, label).toBe(oldWire);
      }
      // 헤더: 번역 4경로의 abcllm 계약만 엄격 terminal 헤더를 보낸다
      expect(Object.keys(variantHeaders(route, before)), label).toEqual(STRICT_HEADER_ROUTES.has(route as CompareRoute) ? ["X-Abcllm-Strict-Terminal"] : []);
      expect(variantHeaders(route, after), label).toEqual({});
      expect(variantNeedsTokenizer(route, before) || variantNeedsTokenizer(route, after), label).toBe(false);
    }
  });
});

describe("second-review requestBudget", () => {
  it("moves to the tokenizer block: same tokenizer question, bytes differ only by context_strategy and both match the real prepare", async () => {
    const asked: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => { asked.push(`${request.url} ${Buffer.concat(chunks).toString("utf8")}`);
        response.end(JSON.stringify({ count: 90, max_model_len: 65_536, tokens: Array.from({ length: 90 }, (_, index) => index + 1) })); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
      const origin = `http://127.0.0.1:${address.port}`;
      const stored = abcllmContract("second-review", { endpoint: `${origin}/v1/chat/completions`, extra: { requestBudget: { requestTokenBound: 32_000,
        maxOutputTokens: 4096, tokenizerEndpoint: `${origin}/tokenize`, tokenizerModel: "fixture-model" } } });
      const before = parsedAbcllm("second-review", stored), after = converted("second-review", stored), sample = sampleFor("second-review");
      expect(variantNeedsTokenizer("second-review", before)).toBe(true);
      expect(variantNeedsTokenizer("second-review", after)).toBe(true);
      const [oldWire, newWire] = [await variantWire("second-review", before, sample), await variantWire("second-review", after, sample)];
      expect(JSON.parse(oldWire).max_tokens).toBe(4096);
      expect(wireFieldDiff(wireFieldDigest(oldWire), wireFieldDigest(newWire))).toEqual(["context_strategy"]);
      setServingContractSnapshotForTest([contractRow(stored)]);
      expect(await preparedWireHash("second-review", "fixture-model", "abcllm", sample, 5_000)).toEqual({ wireHash: sha(oldWire) });
      setServingContractSnapshotForTest([contractRow(after as Record<string, unknown>)]);
      expect(await preparedWireHash("second-review", "fixture-model", "local-direct", sample, 5_000)).toEqual({ wireHash: sha(newWire) });
      expect(asked).toHaveLength(2); expect(asked[1]).toBe(asked[0]);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});

// ── 실제 호출 길(읽은 상태 + 가짜 fetch, DB·네트워크 없음) ───────────────────────────────────────────

describe("shapeCompareCallers", () => {
  const key = "k".repeat(40);
  const reply = (content: string) => JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1, model: "served-fixture",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
  function callersFor(route: TotalBoundRoute, rows: StoredServingContract[], send: (url: string, init: RequestInit) => Promise<Response>) {
    const base = { token: "fixture", loadedAt: Date.now(), rows, registry: [], runtime: null, devices: [] };
    const { contracts } = shapeCompareContracts(route, null, rows, context(rows.map(row => row.model)));
    return shapeCompareCallers({ route, base, contracts, samples: [{ view: { id: "sample:1", label: "" }, input: sampleFor(route) }] },
      send as unknown as Parameters<typeof shapeCompareCallers>[1]);
  }
  it("verifies the bytes with the real prepare, sends them to the contract endpoint with the contract's key, and parses the reply", async () => {
    const sent: { url: string; headers: Record<string, string>; body: string; redirect?: string }[] = [];
    const callers = callersFor("reason-translate", [{ ...contractRow(abcllmContract("reason-translate")), auth: "stored", apiKey: key }], async (url, init) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body), redirect: init.redirect });
      return new Response(reply(JSON.stringify(["페이지에 가입 양식이 있는 작동하는 제품입니다.", "저장소는 제품이 아니라 따라 하기 글입니다."])), { status: 200 });
    });
    const preview = await callers.preview("fixture-model", "sample:1");
    expect(preview).toEqual({ contract: "fixture-model", sample: "sample:1", check: "ok", wireDiff: [], headerDiff: ["-X-Abcllm-Strict-Terminal"] });
    expect(sent).toEqual([]);
    const old = await callers.call("fixture-model", "sample:1", "abcllm");
    const next = await callers.call("fixture-model", "sample:1", "total-bound");
    expect(sent).toHaveLength(2);
    expect(sent.map(request => request.url)).toEqual(["http://engine.test:8000/v1/chat/completions", "http://engine.test:8000/v1/chat/completions"]);
    expect(sent.map(request => request.redirect)).toEqual(["manual", "manual"]);
    expect(sent[0].headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Abcllm-Strict-Terminal": "1" });
    expect(sent[1].headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${key}` });
    expect(sha(sent[0].body)).toBe(old.wireHash); expect(sha(sent[1].body)).toBe(next.wireHash);
    expect(sent[1].body).toBe(sent[0].body);
    for (const result of [old, next]) expect(result).toMatchObject({ refused: null, status: 200, accepted: true, finishReason: "stop",
      usage: { input: 50, output: 10, total: 60 }, items: ["페이지에 가입 양식이 있는 작동하는 제품입니다.", "저장소는 제품이 아니라 따라 하기 글입니다."] });
    expect(old.headers).toEqual(["X-Abcllm-Strict-Terminal"]); expect(next.headers).toEqual([]);
    expect(JSON.stringify([old, next, preview])).not.toContain(key);
  });
  it("shows the context_strategy difference in the preview of a D-6 route and records transport failures", async () => {
    const callers = callersFor("crawl-tagline", [contractRow(abcllmContract("crawl-tagline"))], async () => { throw new Error("connect ECONNREFUSED"); });
    expect(await callers.preview("fixture-model", "sample:1")).toMatchObject({ check: "ok", wireDiff: ["context_strategy"], headerDiff: [] });
    expect(await callers.call("fixture-model", "sample:1", "total-bound")).toMatchObject({ refused: null, status: null, transportError: "network",
      accepted: false, failure: "network" });
  });
  it("sends nothing when the real prepare closes the call (a stored key that does not open)", async () => {
    let sent = 0;
    const callers = callersFor("product-search-profile", [{ ...contractRow(abcllmContract("product-search-profile")), auth: "stored", apiKey: null }],
      async () => { sent++; return new Response("{}", { status: 200 }); });
    expect(await callers.call("fixture-model", "sample:1", "abcllm")).toMatchObject({ refused: "prepare_refused:provider_contract_unavailable", status: null });
    expect(await callers.call("fixture-model", "sample:1", "total-bound")).toMatchObject({ refused: "prepare_refused:provider_contract_unavailable" });
    expect(sent).toBe(0);
  });
});

// ── 응답 검사 ─────────────────────────────────────────────────────────────────────────────────────────

describe("evaluateResponse", () => {
  const envelope = (content: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", created: 1,
    model: "served-fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 7 } }, ...extra });
  it("runs the review route's own terminal check and parser and returns its decision", async () => {
    const contract = converted("crawl-agent-review", abcllmContract("crawl-agent-review")), sample = sampleFor("crawl-agent-review");
    const wire = await variantWire("crawl-agent-review", contract, sample);
    const body = envelope(JSON.stringify({ decision: "reject", reason: "A tutorial repository, not a product.", evidenceIds: ["product"], confidence: 0.9 }));
    expect(await evaluateResponse("crawl-agent-review", contract, wire, sample, 200, body)).toMatchObject({ accepted: true, decision: "reject",
      items: ["A tutorial repository, not a product."], finishReason: "stop", usage: { input: 100, output: 20, total: 120, reasoning: 7 } });
    expect(await evaluateResponse("crawl-agent-review", contract, wire, sample, 200, envelope("not json"))).toMatchObject({ accepted: false,
      failure: "invalid_output:invalid_json" });
    expect(await evaluateResponse("crawl-agent-review", contract, wire, sample, 200, envelope("{}", { model: "other-served" }))).toMatchObject({ accepted: false,
      failure: "invalid_native_terminal" });
    expect(await evaluateResponse("crawl-agent-review", contract, wire, sample, 503, "")).toMatchObject({ accepted: false, failure: "http_503" });
  });
  it("parses text routes with their own parsers and item checkers", async () => {
    const profile = parsedAbcllm("product-search-profile", abcllmContract("product-search-profile"));
    const profileWire = await variantWire("product-search-profile", profile, sampleFor("product-search-profile"));
    expect(await evaluateResponse("product-search-profile", profile, profileWire, sampleFor("product-search-profile"), 200,
      envelope(JSON.stringify({ keywords_en: ["expense tracker", "budget app"], keywords_ko: ["가계부"] })))).toMatchObject({ accepted: true, decision: null,
      items: ["expense tracker · budget app · 가계부"] });
    const verify = converted("product-search-verify", abcllmContract("product-search-verify")), verifySample = sampleFor("product-search-verify");
    const checks = [{ keyword: "budget app", reading: "r", source: "s", source_means: "m", fits: true },
      { keyword: "expense tracker", reading: "r", source: "s", source_means: "m", fits: false }];
    expect(await evaluateResponse("product-search-verify", verify, await variantWire("product-search-verify", verify, verifySample), verifySample, 200,
      envelope(JSON.stringify({ product: "p", checks })))).toMatchObject({ accepted: true, decision: JSON.stringify(["expense tracker"]) });
    const ko = converted("product-tagline-ko", abcllmContract("product-tagline-ko")), koSample = sampleFor("product-tagline-ko");
    const koResult = await evaluateResponse("product-tagline-ko", ko, await variantWire("product-tagline-ko", ko, koSample), koSample, 200,
      envelope(JSON.stringify(["Toolkit은 문서를 더 빠르게 정리해요", ""])));
    expect(koResult).toMatchObject({ accepted: true, itemChecks: { passed: 1, total: 2 } });
    const classify = converted("crawl-publish-classify", abcllmContract("crawl-publish-classify")), classifySample = sampleFor("crawl-publish-classify");
    const category = CATEGORIES[0];
    expect(await evaluateResponse("crawl-publish-classify", classify, await variantWire("crawl-publish-classify", classify, classifySample), classifySample, 200,
      envelope(JSON.stringify({ results: [{ id: 0, category, reason: "fits" }] })))).toMatchObject({ accepted: true, decision: category });
    expect(Object.keys(DEFAULT_CATEGORY_DEFINITIONS)).toContain(category);
  });
});

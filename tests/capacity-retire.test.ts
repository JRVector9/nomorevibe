import { describe, expect, it } from "vitest";
import type { ModelCapacityRoute } from "@/lib/llm/capacity";
import { capacityBlockersText, capacityDeviceRetireBlockers, findStaleCapacityRoutes, modelNamesRoute, routeModelBase,
  type CapacityReferenceSnapshot } from "@/lib/llm/capacity-retire";
import { capacityRetireIssueMessage, pruneInputFromForm, retireInputFromForm } from "@/lib/operations/admin-capacity-retire";

/** 2026-11-09 운영 사실을 본뜬 스냅숏 — supa(연결 없음, 게이트웨이 별칭 route)·supa-direct(살아 있는 서버)·m3-mlx·m1-qwen·gpu3090-qwen 의 남은 별칭. */
const route = (routeId: string, provider: string, model: string, groupId: string, providerBudgetId = groupId): ModelCapacityRoute =>
  ({ routeId, provider, model, providerBudgetId, groupId });
const SUPA = "Inferact/Qwen3.8-27B-NVFP4", OLD_GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit";
const M1 = "11111111-aaaa-4bbb-8ccc-000000000001", M3 = "22222222-aaaa-4bbb-8ccc-000000000002", SUPA_DIRECT = "33333333-aaaa-4bbb-8ccc-000000000003",
  GPU = "44444444-aaaa-4bbb-8ccc-000000000004";
const routes: ModelCapacityRoute[] = [
  route("crawl-agent-review", "abcllm", SUPA, "supa"), route("crawl-tagline", "abcllm", `[supa] Qwen3.8-27B-NVFP4`, "supa"),
  route("product-search-verify", "abcllm", SUPA, "supa"), route("second-review", "abcllm", SUPA, "supa"),
  route("crawl-tagline", "abcllm", "supa", "supa-direct"), route("second-review", "abcllm", "supa", "supa-direct"),
  route("reason-translate", "abcllm", "[MLX] gpt-oss-120b", "m3-mlx"), route("crawl-tagline", "abcllm", "[MLX] gpt-oss-120b", "m3-mlx"),
  route("reason-translate", "abcllm", "gpt-oss-120b", "m3-mlx"),
  route("local-audit", "local-direct", OLD_GEMMA, "m1-qwen", "m1-gemma-backend"), route("local-audit", "local-direct", "m1-gemma", "m1-qwen", "m1-gemma-backend"),
  route("product-tagline-ko", "abcllm", "qwen3.6-27b", "gpu3090-qwen"), route("product-tagline-ko-qwen-legacy", "abcllm", "qwen3.6-27b", "gpu3090-qwen"),
];
const base: CapacityReferenceSnapshot = {
  routes,
  connections: [
    { id: SUPA_DIRECT, label: "Supa", deviceId: "supa-direct", enabled: true, kind: "api", models: ["supa", SUPA], hiddenModels: [] },
    { id: M3, label: "M3 MLX", deviceId: "m3-mlx", enabled: true, kind: "api", models: ["gpt-oss-120b"], hiddenModels: [] },
    { id: M1, label: "M1 Studio", deviceId: "m1-qwen", enabled: true, kind: "api", models: ["m1-gemma"], hiddenModels: [] },
    { id: GPU, label: "gpu3090", deviceId: "gpu3090-qwen", enabled: true, kind: "api", models: ["qwen3.6-27b"], hiddenModels: [] },
  ],
  ranks: [
    { task: "crawl-tagline", slot: 1, rank: 1, connectionId: SUPA_DIRECT, model: "supa", enabled: true, routeId: "crawl-tagline" },
    { task: "second-review", slot: 1, rank: 1, connectionId: SUPA_DIRECT, model: "supa", enabled: true, routeId: "second-review" },
    { task: "reason-translate", slot: 1, rank: 1, connectionId: M3, model: "gpt-oss-120b", enabled: true, routeId: "reason-translate" },
    { task: "audit-review", slot: 1, rank: 1, connectionId: M1, model: "m1-gemma", enabled: true, routeId: "local-audit" },
    { task: "product-tagline-ko", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.6-27b", enabled: true, routeId: "product-tagline-ko" },
  ],
  poolMembers: [], helpers: [],
  contracts: [{ id: 7, routeId: "local:m1-gemma-backend", model: "m1-gemma", transport: "direct", provider: "local-direct", backendId: "m1-gemma-backend", physicalGroup: "m1-qwen" }],
  ledgerOpen: [],
  taskRouteIds: ["crawl-agent-review", "second-review", "crawl-tagline", "reason-translate", "product-tagline-ko", "product-search-verify", "local-audit"],
};
const keys = (list: readonly { route: ModelCapacityRoute }[]) => list.map(entry => `${entry.route.routeId}|${entry.route.model}|${entry.route.groupId}`);

describe("findStaleCapacityRoutes", () => {
  it("lists the gateway-era aliases, the renamed Gemma route and the never-used legacy route — and keeps every live route", () => {
    const result = findStaleCapacityRoutes(base);
    expect(keys(result.candidates)).toEqual([
      `crawl-agent-review|${SUPA}|supa`, "crawl-tagline|[supa] Qwen3.8-27B-NVFP4|supa", `product-search-verify|${SUPA}|supa`, `second-review|${SUPA}|supa`,
      "reason-translate|[MLX] gpt-oss-120b|m3-mlx", "crawl-tagline|[MLX] gpt-oss-120b|m3-mlx",
      `local-audit|${OLD_GEMMA}|m1-qwen`, "product-tagline-ko-qwen-legacy|qwen3.6-27b|gpu3090-qwen",
    ]);
    expect(keys(result.kept)).toEqual(["crawl-tagline|supa|supa-direct", "second-review|supa|supa-direct", "reason-translate|gpt-oss-120b|m3-mlx",
      "local-audit|m1-gemma|m1-qwen", "product-tagline-ko|qwen3.6-27b|gpu3090-qwen"]);
    expect(result.orphanDevices).toEqual(["supa"]);
    const supa = result.candidates.filter(entry => entry.route.groupId === "supa");
    expect(supa.every(entry => entry.deviceWithoutConnection && /장비 은퇴/.test(entry.reason))).toBe(true);
    const gemma = result.candidates.find(entry => entry.route.model === OLD_GEMMA)!;
    expect(gemma.deviceWithoutConnection).toBe(false);
    expect(gemma.aliasHints).toEqual(["같은 엔진의 다른 이름 m1-gemma을(를) 연결 M1 Studio이(가) 내보냅니다 — 이 route 는 옛 이름입니다"]);
    expect(result.candidates.find(entry => entry.route.model === "[MLX] gpt-oss-120b")!.aliasHints[0]).toMatch(/gpt-oss-120b을\(를\) 연결 M3 MLX/);
    // the live route records why it stays: the connection exposes it and the rank calls it
    expect(result.kept.find(entry => entry.route.groupId === "m3-mlx")!.blockers).toEqual([
      { kind: "exposed", detail: "M3 MLX" }, { kind: "rank", detail: "reason-translate#1 1순위 gpt-oss-120b" }]);
    expect(result.kept.find(entry => entry.route.model === "m1-gemma")!.blockers.map(blocker => blocker.kind)).toEqual(["exposed", "rank", "contract"]);
  });

  it("uses the stored model list minus hidden models — a display-collapsed alias still counts, an operator-hidden model does not", () => {
    // supa-direct 의 `supa` 는 화면이 SUPA 로 묶어 숨기지만 저장된 목록에 있다 — 순위가 없어도 노출이라 남는다
    const noRanks = { ...base, ranks: [] };
    expect(keys(findStaleCapacityRoutes(noRanks).kept)).toContain("crawl-tagline|supa|supa-direct");
    const hidden = { ...noRanks, connections: base.connections.map(connection => connection.id === SUPA_DIRECT ? { ...connection, hiddenModels: ["supa"] } : connection) };
    expect(keys(findStaleCapacityRoutes(hidden).candidates)).toContain("crawl-tagline|supa|supa-direct");
    // 꺼진 연결도 노출로 본다(다시 켜면 바로 쓰인다)
    const disabled = { ...noRanks, connections: base.connections.map(connection => ({ ...connection, enabled: false })) };
    expect(findStaleCapacityRoutes(disabled).kept.find(entry => entry.route.model === "supa")!.blockers).toEqual([{ kind: "exposed", detail: "Supa(꺼짐)" }]);
  });

  it("lets exposure block only route ids an AI task can produce (all routes when the list is not given)", () => {
    // gpu3090 이 qwen3.6-27b 를 내보내도 어느 작업도 `…-qwen-legacy` route 를 만들지 않는다 — 노출만으로는 불릴 길이 없다
    expect(keys(findStaleCapacityRoutes(base).candidates)).toContain("product-tagline-ko-qwen-legacy|qwen3.6-27b|gpu3090-qwen");
    const strict = { ...base, taskRouteIds: undefined };
    expect(findStaleCapacityRoutes(strict).kept.find(entry => entry.route.routeId === "product-tagline-ko-qwen-legacy")!.blockers)
      .toEqual([{ kind: "exposed", detail: "gpu3090" }]);
  });

  it("keeps a route referenced by a pool member, a helper assignment, an enabled contract or an unfinished ledger row", () => {
    const legacy = (snapshot: CapacityReferenceSnapshot) => findStaleCapacityRoutes(snapshot).kept
      .find(entry => entry.route.routeId === "product-tagline-ko-qwen-legacy")?.blockers ?? [];
    expect(legacy({ ...base, poolMembers: [{ task: "x", slot: 1, position: 2, connectionId: GPU, model: "other", canonicalModel: "qwen3.6-27b", deviceId: "gpu3090-qwen",
      routeId: "product-tagline-ko-qwen-legacy" }] })).toEqual([{ kind: "pool", detail: "x#1 2번 other" }]);
    expect(legacy({ ...base, helpers: [{ assignmentId: "gpu:ai1", deviceId: "gpu3090-qwen", model: "qwen3.6-27b", liveRouteId: "product-tagline-ko-qwen-legacy",
      liveProvider: "abcllm", shadowRouteId: "primary:ai1", mode: "off" }] })).toEqual([{ kind: "helper", detail: "gpu:ai1(off)" }]);
    // a helper whose live provider differs does not reference the live route (its shadow route is a different id)
    expect(legacy({ ...base, helpers: [{ assignmentId: "gpu:ai1", deviceId: "gpu3090-qwen", model: "qwen3.6-27b", liveRouteId: "product-tagline-ko-qwen-legacy",
      liveProvider: "claude-cli", shadowRouteId: "primary:ai1", mode: "off" }] })).toEqual([]);
    expect(legacy({ ...base, contracts: [{ id: 9, routeId: "product-tagline-ko-qwen-legacy", model: "qwen3.6-27b", transport: "gateway", provider: "abcllm",
      backendId: null, physicalGroup: null }] })).toEqual([{ kind: "contract", detail: "#9 product-tagline-ko-qwen-legacy · qwen3.6-27b(gateway)" }]);
    expect(legacy({ ...base, contracts: [{ id: 10, routeId: "cli:abcllm:product-tagline-ko-qwen-legacy", model: "qwen3.6-27b", transport: "direct", provider: "abcllm",
      backendId: null, physicalGroup: null }] })).toHaveLength(1);
    expect(legacy({ ...base, ledgerOpen: [{ routeId: "product-tagline-ko-qwen-legacy", provider: "abcllm", model: "qwen3.6-27b", groupId: "gpu3090-qwen",
      state: "indeterminate", count: 2 }] })).toEqual([{ kind: "ledger", detail: "indeterminate 2건" }]);
    // a ledger row of another provider is a different route
    expect(legacy({ ...base, ledgerOpen: [{ routeId: "product-tagline-ko-qwen-legacy", provider: "local-direct", model: "qwen3.6-27b", groupId: "gpu3090-qwen",
      state: "waiting", count: 1 }] })).toEqual([]);
  });

  it("matches the per-connection and CLI-engine ledger names a rank derives", () => {
    expect(routeModelBase("qwen@11111111")).toBe("qwen");
    expect(routeModelBase(`qwen@cli-${"a".repeat(32)}`)).toBe("qwen");
    expect(routeModelBase("[MLX] gpt-oss-120b")).toBe("[MLX] gpt-oss-120b");
    expect(modelNamesRoute("qwen", "qwen@11111111")).toBe(true);
    expect(modelNamesRoute("qwen", "qwen")).toBe(true);
    expect(modelNamesRoute("gpt-oss-120b", "[MLX] gpt-oss-120b")).toBe(false);
    const long = "m".repeat(150);
    expect(modelNamesRoute(long, `${long.slice(0, 120)}@cli-${"0".repeat(32)}`)).toBe(true);
    const aliased = { ...base, routes: [...routes, route("product-tagline-ko", "abcllm", `qwen3.6-27b@${GPU.slice(0, 8)}`, "gpu3090-qwen")],
      ranks: [...base.ranks, { task: "product-tagline-ko", slot: 1, rank: 2, connectionId: GPU, model: "qwen3.6-27b", enabled: false, routeId: "product-tagline-ko" }] };
    expect(findStaleCapacityRoutes(aliased).kept.find(entry => entry.route.model.endsWith(GPU.slice(0, 8)))!.blockers)
      .toEqual([{ kind: "exposed", detail: "gpu3090" }, { kind: "rank", detail: "product-tagline-ko#1 1순위 qwen3.6-27b" },
        { kind: "rank", detail: "product-tagline-ko#1 2순위 qwen3.6-27b(꺼짐)" }]);
  });
});

describe("capacityDeviceRetireBlockers", () => {
  it("lets the connection-less gateway device go and blocks every device something still uses", () => {
    expect(capacityDeviceRetireBlockers(base, "supa")).toEqual([]);
    expect(capacityDeviceRetireBlockers(base, "supa-direct")).toEqual([{ kind: "connection", detail: "Supa" }, { kind: "rank", detail: "crawl-tagline#1 1순위 supa" },
      { kind: "rank", detail: "second-review#1 1순위 supa" }]);
    expect(capacityDeviceRetireBlockers(base, "m1-qwen").map(blocker => blocker.kind)).toEqual(["connection", "contract", "rank"]);
    // a rank on another device that still resolves to a supa route (same route id and model) blocks the retire
    const resolved = { ...base, ranks: [...base.ranks, { task: "first-review", slot: 1, rank: 2, connectionId: SUPA_DIRECT, model: SUPA, enabled: true, routeId: "crawl-agent-review" }] };
    expect(capacityDeviceRetireBlockers(resolved, "supa")).toEqual([{ kind: "rank", detail: `first-review#1 2순위 ${SUPA}` }]);
    const busy = { ...base, ledgerOpen: [{ routeId: "second-review", provider: "abcllm", model: SUPA, groupId: "supa", state: "indeterminate", count: 1 }],
      helpers: [{ assignmentId: "supa:ai2", deviceId: "supa", model: SUPA, liveRouteId: "x", liveProvider: "abcllm", shadowRouteId: "y", mode: "off" }],
      poolMembers: [{ task: "second-review", slot: 1, position: 1, connectionId: SUPA_DIRECT, model: "supa", canonicalModel: "supa", deviceId: "supa", routeId: "second-review" }] };
    expect(capacityBlockersText(capacityDeviceRetireBlockers(busy, "supa")))
      .toBe(`pool=second-review#1 1번 supa | helper=supa:ai2(off) | ledger=second-review · ${SUPA} indeterminate 1건`);
  });
});

describe("retire/prune forms and messages", () => {
  const form = (entries: [string, string][]) => { const value = new FormData(); for (const [key, item] of entries) value.append(key, item); return value; };
  it("requires confirm=yes and the version/revision seen when choosing", () => {
    expect(retireInputFromForm(form([["deviceId", "supa"], ["expectedVersion", "3"]]))).toEqual({ input: null, issues: ["model_capacity_retire_unconfirmed"] });
    expect(retireInputFromForm(form([["confirm", "yes"], ["deviceId", "supa"], ["expectedVersion", "3"]]))).toEqual({ input: { deviceId: "supa", expectedVersion: 3 }, issues: [] });
    expect(retireInputFromForm(form([["confirm", "yes"], ["deviceId", "supa"], ["expectedVersion", ""]]))).toEqual({ input: { deviceId: "supa", expectedVersion: null }, issues: [] });
    expect(retireInputFromForm(form([["confirm", "yes"], ["deviceId", "supa"], ["expectedVersion", "x"]])).issues).toEqual(["model_capacity_device_retire_invalid:expectedVersion"]);
    expect(pruneInputFromForm(form([["confirm", "yes"], ["route", JSON.stringify(["a", "b", "c", "d"])]])).issues).toEqual(["model_capacity_routes_prune_invalid:expectedRevision"]);
    expect(pruneInputFromForm(form([["confirm", "yes"], ["expectedRevision", "41"], ["route", JSON.stringify(["a", "b", "c", "d"])], ["route", JSON.stringify(["e", "f", "g", "h"])]])))
      .toEqual({ input: { expectedRevision: 41, routes: [{ routeId: "a", provider: "b", model: "c", groupId: "d" }, { routeId: "e", provider: "f", model: "g", groupId: "h" }] }, issues: [] });
    expect(pruneInputFromForm(form([["confirm", "yes"], ["expectedRevision", "41"], ["route", "[1,2]"]])).issues).toEqual(["model_capacity_routes_prune_invalid:routes"]);
    expect(pruneInputFromForm(form([["confirm", "no"], ["expectedRevision", "41"]])).issues).toEqual(["model_capacity_retire_unconfirmed"]);
  });
  it("turns refusal codes into Korean operator sentences", () => {
    expect(capacityRetireIssueMessage("model_capacity_device_retire_blocked:connection=Supa | rank=crawl-tagline#1 1순위 supa"))
      .toBe("아직 쓰이고 있어 장비를 지우지 않았습니다 — 이 장비에 묶인 AI 연결 Supa · 작업 순위 crawl-tagline#1 1순위 supa. 먼저 그것을 옮기거나 끈 뒤 다시 시도해주세요.");
    expect(capacityRetireIssueMessage("model_capacity_route_prune_blocked:crawl-tagline|abcllm|supa | exposed=Supa"))
      .toBe("아직 쓰이고 있어 route crawl-tagline / abcllm / supa를 빼지 않았습니다 — 이 모델을 아직 내보내는 연결 Supa.");
    expect(capacityRetireIssueMessage("model_capacity_device_already_retired")).toMatch(/이미 지운 장비/);
    expect(capacityRetireIssueMessage("model_capacity_route_missing:a|b|c")).toBe("route a / b / c는 이미 정책에 없습니다(두 번 쓰지 않았습니다). 새로고침해주세요.");
    expect(capacityRetireIssueMessage("model_capacity_routes_prune_revision_mismatch:42")).toMatch(/지금 판 42/);
    expect(capacityRetireIssueMessage("model_capacity_device_retire_version_mismatch:none")).toMatch(/지금 판 없음/);
    expect(capacityRetireIssueMessage("weird")).toBe("weird");
  });
});

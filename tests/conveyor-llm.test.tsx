import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FlowBoard, HumanDetail, ResponsePanel, StationDetail } from "@/app/(operator)/admin/flow/FlowBoard";
import { buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import {
  buildStationLlm, NO_LLM, OFF_BELT_TASKS, RUNTIME_FRESH_MS, STATION_TASKS, type LlmConnection, type LlmInputs, type LlmRankRow, type LlmRuntime, type LlmUsedRow,
} from "@/lib/operations/conveyor-llm";
import { stationResponse, STATION_JOBS } from "@/lib/operations/flow-response";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import type { HourlySeries } from "@/lib/operations/dashboard";
import { emptySearchHealth } from "@/lib/operations/search-health-model";
import type { ThroughputStage } from "@/lib/operations/throughput-model";

const NOW = "2026-11-02T21:30:00.000Z";
const conn = (id: string, label: string, patch: Partial<LlmConnection> = {}): LlmConnection => ({ id, label, kind: "api", cliTool: null, hasKey: true, enabled: true, ...patch });
const QWEN = conn("08e71fe8-0000-4000-8000-000000000001", "gpu3090-qwen");
const M3 = conn("5a1b2c3d-0000-4000-8000-000000000002", "m3-mlx (2)");
const CLAUDE = conn("c1c1c1c1-0000-4000-8000-000000000003", "Claude CLI", { kind: "cli", cliTool: "claude", hasKey: false });
const rank = (task: string, rankNo: number, connection: LlmConnection, model: string, patch: Partial<LlmRankRow> = {}): LlmRankRow =>
  ({ task, slot: 1, rank: rankNo, connectionId: connection.id, model, enabled: true, ...patch });
const used = (routeId: string, provider: string, model: string, count: number): LlmUsedRow => ({ routeId, provider, model, count, lastAt: "2026-11-02T21:25:00.000Z" });

/** 2026-11-02 정상: 1차 gpu3090-qwen·qwen3.8-flash-next, 2차 투표자 1 m3-mlx (2)·gpt-oss-120b */
function healthy(patch: Partial<LlmInputs> = {}): LlmInputs {
  return {
    now: NOW, connections: [QWEN, M3, CLAUDE],
    rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next"), rank("second-review", 1, M3, "gpt-oss-120b"),
      rank("crawl-tagline", 1, QWEN, "qwen3.8-flash-next"), rank("product-tagline-ko", 1, QWEN, "qwen3.8-flash-next"),
      rank("product-translate", 1, M3, "gpt-oss-120b"), rank("reason-translate", 1, QWEN, "qwen3.8-flash-next"),
      rank("product-intro-check", 1, CLAUDE, "sonnet"), rank("publish-classify", 1, CLAUDE, "sonnet"),
      rank("product-search-profile", 1, QWEN, "qwen3.8-flash-next"), rank("product-search-verify", 1, QWEN, "qwen3.8-flash-next")],
    used: [used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 128), used("second-review", "abcllm", "gpt-oss-120b", 40)],
    runtime: {},
    effective: {
      "product-intro-check": {
        source: "CLI 환경 설정",
        models: [{ model: "sonnet", where: "Claude CLI" }],
        error: null,
        skip: null,
        notes: [],
      },
    },
    ...patch,
  };
}

describe("station → AI task map", () => {
  it("places every AI task on exactly one station or marks it off the belt — a new task must be placed deliberately", () => {
    const placed = [...Object.values(STATION_TASKS).flat(), ...OFF_BELT_TASKS];
    expect([...placed].sort()).toEqual(AI_TASKS.map((task) => task.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("calls a station 'no LLM' only when none of its jobs is an AI task job (discover · fetch · judge)", () => {
    const aiJobs = new Set(AI_TASKS.flatMap((task) => task.jobs));
    for (const key of ["discover", "fetch", "judge"] as const) {
      expect(STATION_TASKS[key], key).toEqual([]);
      for (const row of STATION_JOBS[key]) expect(aiJobs.has(row.job), `${key} ${row.job}`).toBe(false);
      expect(NO_LLM[key].why.length).toBeGreaterThan(20);
    }
    // 반대로 모델을 쓰는 칸의 잡은 AI 작업 목록에 있다
    for (const key of ["first", "second", "profile", "keywords"] as const) {
      expect(STATION_JOBS[key].some((row) => aiJobs.has(row.job)), key).toBe(true);
    }
  });

  it("answers on every station — LLM stations with a model, rule stations with 'LLM 없음'", () => {
    const models = buildStationLlm(healthy());
    expect(models.judge).toMatchObject({ kind: "none", short: "규칙" });
    expect(models.discover.kind).toBe("none");
    expect(models.fetch.kind).toBe("none");
    expect(models.sink.kind).toBe("none");
    for (const key of ["first", "second", "profile", "publish", "keywords", "human", "support"] as const) expect(models[key].kind, key).toBe("llm");
  });
});

describe("configured rank vs the model actually used in the last hour", () => {
  it("shows connection · model for the rank that is serving (정상)", () => {
    const models = buildStationLlm(healthy());
    expect(models.first).toMatchObject({ kind: "llm", flag: null });
    if (models.first.kind !== "llm") throw new Error("llm");
    expect(models.first.head).toMatchObject({ state: "ok", head: { model: "qwen3.8-flash-next", where: "gpu3090-qwen", rank: 1, source: "used", count: 128 } });
    if (models.second.kind !== "llm") throw new Error("llm");
    expect(models.second.head.head).toMatchObject({ model: "gpt-oss-120b", where: "m3-mlx (2)", rank: 1 });
    expect(models.second.flag).toBeNull();
  });

  it("flags when the ledger shows a lower rank serving (키 없는 연결이라 건너뜀 → 2순위로 넘어감)", () => {
    const keyless = conn(QWEN.id, QWEN.label, { hasKey: false });
    const inputs = healthy({ connections: [keyless, M3, CLAUDE],
      rows: [rank("first-review", 1, keyless, "qwen3.8-flash-next"), rank("first-review", 2, M3, "gpt-oss-120b"), rank("second-review", 1, M3, "gpt-oss-120b")],
      used: [used("crawl-agent-review", "abcllm", "gpt-oss-120b", 60)] });
    const first = buildStationLlm(inputs).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.head.state).toBe("fallback");
    expect(first.flag).toEqual({ tone: "warn", text: "2순위로 넘어감" });
    expect(first.head.head).toMatchObject({ model: "gpt-oss-120b", where: "m3-mlx (2)", rank: 2, source: "used" });
    expect(first.head.note).toContain("1순위 연결에 키가 없음");
    expect(first.head.slots[0].ranks[0].problem).toContain("키가 없음");
  });

  it("does not call a keyless local-direct connection stopped — gpu3090-qwen serves without a key", () => {
    // 운영 2026-11-04: 1차는 gpu3090-qwen 직접 연결로 5분에 20건 처리 중인데, hasKey=false 를 멈춤으로 보였다
    const local = conn(QWEN.id, QWEN.label, { hasKey: false, baseUrl: "http://100.77.43.63:8090/v1" });
    const first = buildStationLlm(healthy({ connections: [local, M3, CLAUDE],
      rows: [rank("first-review", 1, local, "qwen3.8-flash-next"), rank("second-review", 1, M3, "gpt-oss-120b")],
      used: [used("crawl-agent-review", "local-direct", "qwen3.8-flash-next", 236)] })).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.stopped).toEqual([]);
    expect(first.head.state).toBe("ok");
    expect(first.head.slots[0].ranks[0].problem).toBeNull();
    expect(first.head.head).toMatchObject({ model: "qwen3.8-flash-next", where: "gpu3090-qwen", rank: 1, source: "used" });
  });

  it("names the skipped rank from the worker's own last tick when it is fresh, and ignores a stale one", () => {
    const runtime = (at: string): Record<string, LlmRuntime> => ({ "first-review": { at, degraded: null, unusable: [{ rank: 1, code: "engine_no_key", text: "엔진이 키를 거절함" }] } });
    const rows = [rank("first-review", 1, QWEN, "qwen3.8-flash-next"), rank("first-review", 2, M3, "gpt-oss-120b"), rank("second-review", 1, M3, "gpt-oss-120b")];
    const fresh = buildStationLlm(healthy({ rows, runtime: runtime("2026-11-02T21:20:00.000Z"), used: [] })).first;
    if (fresh.kind !== "llm") throw new Error("llm");
    expect(fresh.head.slots[0].ranks[0].problem).toBe("엔진이 키를 거절함");
    expect(fresh.head.state).toBe("fallback");
    const stale = buildStationLlm(healthy({ rows, runtime: runtime(new Date(Date.parse(NOW) - RUNTIME_FRESH_MS - 60_000).toISOString()), used: [] })).first;
    if (stale.kind !== "llm") throw new Error("llm");
    expect(stale.head.slots[0].ranks[0].problem).toBeNull();
    expect(stale.head.state).toBe("idle");
  });

  it("marks a ledger model that is on no rank as 설정과 다름, and shows the configured value with no calls in the hour", () => {
    const other = buildStationLlm(healthy({ used: [used("crawl-agent-review", "abcllm", "supa-qwen", 9)] })).first;
    if (other.kind !== "llm") throw new Error("llm");
    expect(other.head.state).toBe("other");
    expect(other.flag).toEqual({ tone: "warn", text: "순위에 없는 모델" });
    // 장부 provider 키(abcllm — 엔진 직접 계약의 옛 내부 이름)는 화면에 쓰지 않는다. 장비 그룹이 없으면 「직접 연결」
    expect(other.head.head).toMatchObject({ model: "supa-qwen", where: "직접 연결", rank: null });
    const idle = buildStationLlm(healthy({ used: [] })).first;
    if (idle.kind !== "llm") throw new Error("llm");
    expect(idle.head).toMatchObject({ state: "idle", head: { source: "set", model: "qwen3.8-flash-next" } });
    expect(idle.flag).toBeNull();
  });

  it("names the device (gpu3090), not the ledger provider key, for calls that match no rank — 2026-11-02 1차 순위 지워짐", () => {
    // 1차 순위가 비었는데 장부에는 gpu3090 직접 연결로 부른 호출이 남아 있다(nomorevibe 는 abcLLM 을 쓰지 않는다)
    const rows = healthy().rows!.filter((row) => row.task !== "first-review");
    const cleared = buildStationLlm(healthy({ rows, used: [{ ...used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 52), groups: ["gpu3090-qwen"] }] })).first;
    if (cleared.kind !== "llm") throw new Error("llm");
    expect(cleared.head.used?.[0]).toMatchObject({ text: "gpu3090 · qwen3.8-flash-next", where: "gpu3090", rank: null });
    // 장비 그룹이 없어도 같은 모델을 순위에 둔 연결이 하나뿐이면 그 연결 이름
    const noGroup = buildStationLlm(healthy({ rows, used: [used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 52)] })).first;
    if (noGroup.kind !== "llm") throw new Error("llm");
    expect(noGroup.head.used?.[0].where).toBe("gpu3090-qwen");
    const page = renderToStaticMarkup(<FlowBoard data={buildConveyor(conveyorInputs({ models: buildStationLlm(healthy({ rows,
      used: [{ ...used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 52), groups: ["gpu3090"] }, used("second-review", "abcllm", "gpt-oss-120b", 40)] })) }))} />);
    expect(page).not.toMatch(/abcllm/i);
  });

  it("2026-11-09: 장비 그룹은 그 장비를 쓰는 연결 이름으로 — 연결이 없는 장비만 서버 이름", () => {
    const rows = healthy().rows!.filter((row) => row.task !== "first-review");
    const connections = [{ ...QWEN, deviceId: "gpu3090-qwen" }, { ...M3, label: "m3-gpt-oss", deviceId: "m3-mlx" }, conn("d", "m3-deepseek", { deviceId: "m3-mlx" }), CLAUDE];
    const named = buildStationLlm(healthy({ connections, rows, used: [{ ...used("crawl-agent-review", "abcllm", "deepseek-v4.1-flash-1017", 5), groups: ["m3-mlx"] }] })).first;
    if (named.kind !== "llm") throw new Error("llm");
    expect(named.head.used?.[0]).toMatchObject({ where: "m3-deepseek · m3-gpt-oss" });
    const orphan = buildStationLlm(healthy({ connections, rows, used: [{ ...used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 5), groups: ["supa"] }] })).first;
    if (orphan.kind !== "llm") throw new Error("llm");
    expect(orphan.head.used?.[0].where).toBe("Supa");
  });

  it("recognises the same model on another connection by its ledger alias (모델@연결 8자)", () => {
    const rows = [rank("first-review", 1, QWEN, "gpt-oss-120b"), rank("first-review", 2, M3, "gpt-oss-120b"), rank("second-review", 1, CLAUDE, "sonnet")];
    const first = buildStationLlm(healthy({ rows, used: [used("crawl-agent-review", "abcllm", "gpt-oss-120b@5a1b2c3d", 4)] })).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.head.head).toMatchObject({ rank: 2, where: "m3-mlx (2)" });
    expect(first.head.state).toBe("fallback");
  });

  it("does not claim actual use when the ledger could not be read or the route has no ledger — configured only", () => {
    const unread = buildStationLlm(healthy({ used: null })).first;
    if (unread.kind !== "llm") throw new Error("llm");
    expect(unread.head).toMatchObject({ state: "set_only", usedWhy: "unread", used: null });
    const profile = buildStationLlm(healthy()).keywords;
    if (profile.kind !== "llm") throw new Error("llm");
    const embedding = profile.tasks.find((task) => task.task === "product-embedding")!;
    expect(embedding).toMatchObject({ usedWhy: "no_ledger", used: null });
  });
});

describe("empty ranks stop the job (no_task_models, 2026-11-02 21:13Z)", () => {
  const cleared = healthy({ rows: healthy().rows!.filter((row) => row.task !== "first-review"), used: [] });

  it("reads 모델 없음 — 멈춤 for a live task with no rank, but not for a task the worker does not read yet", () => {
    const first = buildStationLlm(cleared).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first).toMatchObject({ flag: { tone: "bad", text: "모델 없음 — 멈춤" }, stopped: ["1차 AI 검수"], liveCount: 1 });
    expect(first.head).toMatchObject({ state: "none", head: null });
    expect(first.head.note).toContain("no_task_models");
    // 소개 검수는 실행 쪽이 아직 순위를 읽지 않는다 — 순위가 비어도 멈추지 않는다
    const rows = healthy().rows!.filter((row) => row.task !== "product-intro-check");
    const profile = buildStationLlm(healthy({ rows })).support;
    if (profile.kind !== "llm") throw new Error("llm");
    const intro = profile.tasks.find((task) => task.task === "product-intro-check")!;
    expect(intro).toMatchObject({ live: false, state: "set_only" });
    expect(profile.stopped).toEqual([]);
  });

  it("turns the station into 막힘 with the model reason, and makes it the bottleneck even with nothing waiting", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(cleared) }));
    const first = conveyor.stations.find((station) => station.key === "first")!;
    expect(first).toMatchObject({ tone: "jam", status: "모델 없음 — 멈춤" });
    expect(first.reason).toContain("작업 ↔ AI 모델");
    expect(conveyor.bottleneck).toBe("first");
    expect(conveyor.headline.title).toContain("AI 1차 — 모델 없음 — 멈춤");
  });

  it("keeps public translation model failures out of the pre-publication profile bottleneck", () => {
    const rows = healthy().rows!.filter((row) => row.task !== "product-translate");
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(healthy({ rows })) }));
    const profile = conveyor.stations.find((station) => station.key === "profile")!;
    expect(profile).toMatchObject({ tone: "idle", reason: null });
    expect(profile.llm).toMatchObject({ kind: "llm", stopped: [], liveCount: 1 });
    expect(conveyor.supportLlm).toMatchObject({ kind: "llm", stopped: ["제품 다국어 번역"], liveCount: 3 });
    expect(conveyor.bottleneck).not.toBe("profile");
    const html = renderToStaticMarkup(<FlowBoard data={conveyor} />);
    expect(html).toContain("제품 다국어 번역");
    expect(html).toContain('data-llm="bad"');
  });

  it("links the incident response to the rank screen and tells what to compare in the work log", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(cleared) }));
    const response = stationResponse("first", conveyor, null);
    expect(response.checks[0]).toContain("순위가 비어 있어 이 작업이 돌지 않습니다(no_task_models)");
    expect(response.steps[0]).toMatchObject({ kind: "link", href: "/admin/models/tasks", risk: "careful" });
    expect(response.steps).toContainEqual(expect.objectContaining({ kind: "link", href: "/admin/activity?group=settings" }));
    // 새 쓰기 길은 없다 — 링크 둘이 모델 쪽 조치 전부
    for (const step of response.steps) if (step.kind === "link") expect(step.href.startsWith("/admin")).toBe(true);
  });

  it("does not attach a previous rank's contract failure to a newly saved model", () => {
    const runtime = { "first-review": { at: "2026-11-02T21:20:00.000Z",
      degraded: { code: "all_ranks_unusable", detail: "old rank" },
      unusable: [{ rank: 1, code: "no_direct_contract", text: "이 연결·모델의 엔진 직접 계약이 없음" }] } };
    // The number stays 1, including when the same model is saved again to create its contract.
    for (const model of ["Inferact/Qwen3.8-27B-NVFP4", "qwen3.8-flash-next"]) {
      const first = buildStationLlm(healthy({ rows: [rank("first-review", 1, QWEN, model,
        { updatedAt: "2026-11-02T21:21:00.000Z" })], runtime, used: [] })).first;
      if (first.kind !== "llm") throw new Error("llm");
      expect(first.head.state).toBe("idle");
      expect(first.head.slots[0].ranks[0].problem).toBeNull();
      expect(first.stopped).toEqual([]);
    }
  });

  it("retains a contract failure observed after the current ranks were saved", () => {
    const first = buildStationLlm(healthy({ rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next",
      { updatedAt: "2026-11-02T21:20:00.000Z" })], used: [], runtime: { "first-review": {
      at: "2026-11-02T21:21:00.000Z", degraded: { code: "all_ranks_unusable", detail: "current rank" },
      unusable: [{ rank: 1, code: "no_direct_contract", text: "현재 계약 없음" }],
    } } })).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.head.state).toBe("stuck");
    expect(first.head.slots[0].ranks[0].problem).toBe("현재 계약 없음");
  });

  it("ignores an old tick that started before the save and finished afterwards", () => {
    const first = buildStationLlm(healthy({ rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next",
      { updatedAt: "2026-11-02T21:21:00.000Z" })], used: [], runtime: { "first-review": {
      startedAt: "2026-11-02T21:20:00.000Z", at: "2026-11-02T21:22:00.000Z",
      degraded: { code: "all_ranks_unusable", detail: "old tick" },
      unusable: [{ rank: 1, code: "no_direct_contract", text: "old contract" }],
    } } })).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.head.state).toBe("idle");
    expect(first.head.slots[0].ranks[0].problem).toBeNull();
    expect(first.stopped).toEqual([]);
  });

  it("keeps current disabled and empty ranks stopped despite a previous tick", () => {
    const runtime = { "first-review": { at: "2026-11-02T21:20:00.000Z", degraded: null,
      unusable: [{ rank: 1, code: "no_direct_contract", text: "old contract" }] } };
    const stopped = buildStationLlm(healthy({ rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next",
      { enabled: false, updatedAt: "2026-11-02T21:21:00.000Z" })], runtime, used: [] })).first;
    if (stopped.kind !== "llm") throw new Error("llm");
    expect(stopped.head.state).toBe("stuck");
    expect(stopped.head.slots[0].ranks[0].problem).toBe("순위가 꺼져 있음");
    expect(buildStationLlm(healthy({ rows: [], runtime, used: [] })).first).toMatchObject({ head: { state: "none" } });
  });

  it("stops when every rank is unusable (all connections keyless or off)", () => {
    const keyless = conn(QWEN.id, QWEN.label, { hasKey: false });
    const off = conn(M3.id, M3.label, { enabled: false });
    const rows = [rank("first-review", 1, keyless, "qwen3.8-flash-next"), rank("first-review", 2, off, "gpt-oss-120b"), rank("second-review", 1, CLAUDE, "sonnet")];
    const first = buildStationLlm(healthy({ connections: [keyless, off, CLAUDE], rows, used: [] })).first;
    if (first.kind !== "llm") throw new Error("llm");
    expect(first.head.state).toBe("stuck");
    expect(first.flag?.text).toBe("쓸 수 있는 순위 없음 — 멈춤");
    expect(first.head.note).toContain("1순위 연결에 키가 없음");
    expect(first.head.note).toContain("2순위 연결이 꺼져 있음");
  });
});

describe("1차 and 2차 on the same model", () => {
  const same = healthy({ rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next"), rank("second-review", 1, QWEN, "qwen3.8-flash-next")],
    used: [used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 120)] });

  it("allows both stations to use the same model without a false warning", () => {
    const models = buildStationLlm(same);
    for (const key of ["first", "second"] as const) {
      const station = models[key];
      if (station.kind !== "llm") throw new Error("llm");
      expect(station.sameModel, key).toBe(false);
      expect(station.warnings).toEqual([]);
    }
    expect(models.second.kind === "llm" && models.second.flag).toBeNull();
    expect(models.first.kind === "llm" && models.first.flag).toBeNull();
  });

  it("keeps both stations flowing when their configured model is shared", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(same) }));
    expect(conveyor.stations.find((station) => station.key === "second")).toMatchObject({ tone: "flow" });
    expect(conveyor.stations.find((station) => station.key === "first")).toMatchObject({ tone: "flow" });
    expect(stationResponse("second", conveyor, null).checks.join(" ")).not.toContain("표를 못 냅니다");
  });

  it("does not reject shared models behind server prefixes and connection aliases", () => {
    const prefixed = healthy({ rows: [rank("first-review", 1, QWEN, "[gpu3090] qwen3.8-flash-next"), rank("second-review", 1, M3, "qwen3.8-flash-next@5a1b2c3d")], used: [] });
    expect(buildStationLlm(prefixed).second.kind === "llm" && buildStationLlm(prefixed).second).toMatchObject({ sameModel: false });
    const second = buildStationLlm(healthy({ rows: [...same.rows!, rank("second-review", 1, M3, "gpt-oss-120b", { slot: 2 })], used: [] })).second;
    expect(second.kind === "llm" && second.sameModel).toBe(false);
    expect(buildStationLlm(healthy()).second.kind === "llm" && (buildStationLlm(healthy()).second as { sameModel: boolean }).sameModel).toBe(false);
  });

  it("does not warn when 1차 has no model at all — the stop is the finding", () => {
    const models = buildStationLlm(healthy({ rows: [rank("second-review", 1, QWEN, "qwen3.8-flash-next")], used: [] }));
    expect(models.second.kind === "llm" && models.second.sameModel).toBe(false);
  });
});

describe("공개 전 소개와 공개 후·보조 작업", () => {
  it("preserves all task observations and rank-editor tasks while splitting their actual execution scope", () => {
    const models = buildStationLlm(healthy());
    const profile = models.profile;
    const support = models.support;
    if (profile.kind !== "llm" || support.kind !== "llm") throw new Error("llm");
    expect(profile.tasks.map((task) => task.task)).toEqual(["crawl-tagline"]);
    expect(support.tasks.map((task) => task.task)).toEqual(["product-tagline-ko", "korean-translation-direct", "product-translate", "reason-translate", "product-intro-check"]);
    expect([...profile.tasks, ...support.tasks].map((task) => task.task)).toEqual(STATION_TASKS.profile);
    expect(support.more).toBe(2);
    // 분류 대기가 있어 프로필 준비가 쌓임이면 자세히가 프로필 준비로 열린다
    const slow = conveyorInputs({ models, classification: { held: 5, nextRetryAt: null },
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second"), stage("publish", { completed5m: 0 })] } });
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor(slow)} />);
    // Current-call cards no longer collapse the other models into an “외 N” summary.
    expect(html).not.toContain("외 2");
    expect(html).toContain("LLM 현재 호출");
    for (const label of ["수집 소개 짓기", "한국어 소개 번역", "제품 다국어 번역", "심사 사유 번역", "소개 검수"]) expect(html, label).toContain(label);
  });

  it("puts a problem task first so the card never hides it behind a healthy one", () => {
    const rows = healthy().rows!.filter((row) => row.task !== "reason-translate");
    const profile = buildStationLlm(healthy({ rows })).support;
    if (profile.kind !== "llm") throw new Error("llm");
    expect(profile.head.task).toBe("reason-translate");
    expect(profile.flag?.text).toBe("모델 없음 — 멈춤");
  });
});

describe("unreadable inputs", () => {
  it("says 확인 못함 for model stations and keeps 'LLM 없음' for rule stations — never a false 정상", () => {
    const models = buildStationLlm(healthy({ rows: null }));
    expect(models.first).toMatchObject({ kind: "unknown" });
    expect(models.profile).toMatchObject({ kind: "unknown" });
    expect(models.support).toMatchObject({ kind: "unknown" });
    expect(models.judge).toMatchObject({ kind: "none" });
    const conveyor = buildConveyor(conveyorInputs({ models }));
    expect(conveyor.stations.find((station) => station.key === "first")).toMatchObject({ tone: "flow" });
    const html = renderToStaticMarkup(<FlowBoard data={conveyor} />);
    expect(html).toContain("확인 못함");
    expect(html).toContain("LLM 없음 · 규칙");
  });

  it("falls back to 확인 못함 on every card when no model read was passed at all", () => {
    const html = renderToStaticMarkup(<FlowBoard data={buildConveyor(conveyorInputs({ models: null }))} />);
    expect(html.match(/class="cv-llm"/g)).toHaveLength(11);
    expect(html).toContain('data-llm="unknown"');
  });
});

describe("card and detail", () => {
  const html = (models = buildStationLlm(healthy())) => renderToStaticMarkup(<FlowBoard data={buildConveyor(conveyorInputs({ models }))} />);

  it("gives all station, human, public and support cards the same model observation block", () => {
    const page = html();
    expect(page.match(/class="cv-llm"/g)).toHaveLength(11);
    expect(page).toContain("LLM 없음 · 규칙");
    expect(page).toContain("LLM 없음 · 탐색 API");
    expect(page).toContain("LLM 없음 · 내려받기");
    expect(page).toContain("LLM 없음 · 게시");
    expect(page).toContain("gpu3090-qwen · qwen3.8-flash-next");
    expect(page).toContain("m3-mlx (2) · gpt-oss-120b");
    // This fixture has historical use but no current-call observation; never call it a live request.
    expect(page).toContain('<span class="cv-llm-k">LLM 현재 호출</span>');
    expect(page).toContain("현재 호출 일부 미확인");
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(healthy()) }));
    const detail = renderToStaticMarkup(<StationDetail station={conveyor.stations.find(station => station.key === "first")!} hours={conveyor.hours} />);
    expect(detail).toMatch(/<dt class="cv-llmd-k">최근 1시간<\/dt><dd class="cv-llmd-v">[^]*?gpu3090-qwen · <b>qwen3\.8-flash-next<\/b>[^]*?128건 · 1차 AI 검수/);
  });

  it("prints the flag with an icon and words, never colour alone", () => {
    const cleared = html(buildStationLlm(healthy({ rows: healthy().rows!.filter((row) => row.task !== "first-review"), used: [] })));
    expect(cleared).toMatch(/<span class="cv-badge" data-tone="jam"><span aria-hidden="true">■<\/span>모델 없음 — 멈춤<\/span>/);
    expect(cleared).toContain('<span class="cv-llmd-state" data-state="none">모델 없음 — 멈춤</span>');
  });

  it("links the model rows of the open detail to /admin/models/tasks and shows set vs actual per task", () => {
    // 1차가 막혀(처리 0) 자세히가 1차로 열린다
    const stalled = buildConveyor(conveyorInputs({ models: buildStationLlm(healthy()),
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first", { status: "stalled", waiting: 40, oldestMinutes: 50, completed5m: 0 }), stage("second"), stage("publish")] } }));
    const page = renderToStaticMarkup(<FlowBoard data={stalled} />);
    expect(page).toContain('class="cv-llmd"');
    expect(page).toContain('href="/admin/models/tasks#tasks"');
    expect(page).toContain("작업 ↔ AI 모델에서 순위 보기·바꾸기");
    // Rows separate current calls, saved ranks, and historical completed calls.
    expect(page).toMatch(/<dt class="cv-llmd-k">현재 호출<\/dt><dd class="cv-llmd-v">[^]*?현재 호출 일부 미확인<\/span><\/span><\/dd>/);
    expect(page).toMatch(/<dt class="cv-llmd-k">설정<\/dt><dd class="cv-llmd-v">[^]*?<span class="flow-model-rank">1순위<\/span><span>gpu3090-qwen · qwen3\.8-flash-next<\/span>/);
    expect(page).toMatch(/<dt class="cv-llmd-k">최근 1시간<\/dt><dd class="cv-llmd-v">[^]*?gpu3090-qwen · <b>qwen3\.8-flash-next<\/b>[^]*?128건 · 1차 AI 검수/);
  });

  it("explains a rule station's 'LLM 없음' with the code it was checked against", () => {
    const judge = renderToStaticMarkup(<FlowBoard data={buildConveyor(conveyorInputs({ models: buildStationLlm(healthy()),
      throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge", { status: "stalled", waiting: 40, oldestMinutes: 50, completed5m: 0 }), stage("first"), stage("second"), stage("publish")] } }))} />);
    expect(judge).toContain("crawl-judge 모델 없음");
    expect(judge).toContain("<b>LLM 없음 · 규칙</b>");
  });

  it("is still read-only: the read module has no write, no key fill and no snapshot reload", () => {
    const source = readFileSync(path.resolve(__dirname, "../lib/operations/conveyor-llm-read.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(|INSERT INTO|UPDATE |DELETE FROM|maybeFillConnectionKeys|ensureAiTaskModels|ensureReviewTaskRanks/);
    expect(source).toContain('accessMode: "read only"');
    const board = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/flow/FlowBoard.tsx"), "utf8");
    expect(board).not.toMatch(/use server|action=\{/);
  });
});

// ── 공통 입력 ─────────────────────────────────────────────────────────────────────────────────
function stage(key: ThroughputStage["key"], patch: Partial<ThroughputStage> = {}): ThroughputStage {
  return { key, label: key, unit: key === "second" ? "표" : "건", completed1m: 1, completed5m: 5, progress5m: 5, waiting: 0,
    manualAttention: 0, oldestMinutes: 0, enabled: true, errors5m: 0, queueNote: "", detail: "", status: "processing", ...patch };
}
function hourly(): HourlySeries {
  const points = Array.from({ length: 24 }, (_, index) => ({
    hour: new Date(Date.parse("2026-11-01T22:00:00.000Z") + index * 3_600_000).toISOString(),
    discovered: 40, judged: 30, firstReviews: 20, firstFailed: 0, secondReviews: 10, secondAgreed: 8, published: 5, publishedKorean: 1, keywords: 6, taglines: 7,
  }));
  const { hour: _hour, ...lastHour } = points.at(-1)!;
  void _hour;
  return { measuredAt: NOW, points, lastHour };
}
function human(): HumanQueueOverview {
  return { held: 120, ids: { ai: [], second: [], agreed: [], human: [] }, stages: { ai: 10, second: 60, agreed: 20, human: 30 },
    agreed: { reject: 15, approve: 5 }, person: 50, secondIds: {} as HumanQueueOverview["secondIds"], second: {} as HumanQueueOverview["second"],
    secondPublished: 0, wait: { oldestDays: 3, stalled: 0, in24h: 12 }, decided24h: { approve: 4, reject: 6 },
    aiDecisions: { counts: {} as HumanQueueOverview["aiDecisions"]["counts"], ids: new Map() }, ...{} };
}
function conveyorInputs(patch: Partial<ConveyorInputs> = {}): ConveyorInputs {
  return {
    now: NOW, enabled: true,
    throughput: { measuredAt: NOW, stages: [stage("fetch"), stage("judge"), stage("first"), stage("second"), stage("publish")] },
    flow: { stages: [{ key: "discover", label: "발견 누적", waiting: 90_000, entered: 900, left: null, job: "crawl-seed" },
      { key: "fetch", label: "원본 수집 대기", waiting: 3, entered: 900, left: 880, job: "crawl-fetch" }], bottleneck: null, published: 12_345 },
    hourly: hourly(), human: human(), progress: { stages: [], liveness: [] },
    search: { ...emptySearchHealth(), total: 100, pendingGeneration: 4, pendingVerification: 2, oldestVerificationMinutes: 12, generatedRecent: 3, verifiedRecent: 2 },
    holds: [], rejected: 0, classification: { held: 0, nextRetryAt: null },
    sources: [{ job: "crawl-seed", label: "GitHub 검색", lastSuccessAt: "2026-11-02T21:20:00.000Z", paused: false, failing: false }],
    ...patch,
  };
}

describe("칸 자세히 · 장애 대응의 틀 (2026-11-04 4차: 섹션 나누기·정렬)", () => {
  const SECTIONS = ["상태", "모델 — 현재 호출·설정·최근 1시간", "처리량", "이 칸에서 빠진 보류", "바로 가기"];
  const titles = (markup: string) => [...markup.matchAll(/<h3 class="cv-sec-h" id="cv-sec-[a-z]+">([^<]+)<\/h3>/g)].map((match) => match[1]);
  const same = healthy({ rows: [rank("first-review", 1, QWEN, "qwen3.8-flash-next"), rank("second-review", 1, QWEN, "qwen3.8-flash-next")],
    used: [used("crawl-agent-review", "abcllm", "qwen3.8-flash-next", 120)] });

  it("gives every station the same five titled sections in the same order — empty ones answer with one quiet line", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(healthy()) }));
    for (const station of conveyor.stations) {
      const markup = renderToStaticMarkup(<StationDetail station={station} hours={conveyor.hours} />);
      expect(titles(markup), station.key).toEqual(SECTIONS);
      if (!station.holds.length) expect(markup, station.key).toContain("이 칸에서 사람 확인(보류)으로 빠진 것이 없습니다.");
      if (!station.reason) expect(markup, station.key).toContain("이 칸에 걸린 문제가 없습니다.");
    }
    // 사람 심사는 보류가 모이는 쪽이라 ④ 없이 같은 차례
    const human = renderToStaticMarkup(<HumanDetail human={conveyor.human!} />);
    expect(titles(human)).toEqual(SECTIONS.filter((title) => title !== "이 칸에서 빠진 보류"));
  });

  it("writes a warning once — the status section holds it, the model section keeps only the state tag", () => {
    const models = buildStationLlm(same);
    // 같은 모델 사용은 경고가 아니다. 표시 전용 fixture에 실제 연결 경고를 넣어 중복 표시 계약을 검증한다.
    for (const key of ["first", "second"] as const) {
      const model = models[key];
      if (model.kind !== "llm") throw new Error("llm");
      models[key] = { ...model, warnings: ["엔진 연결 상태를 확인하세요."] };
    }
    const conveyor = buildConveyor(conveyorInputs({ models }));
    for (const key of ["first", "second"] as const) {
      const station = conveyor.stations.find((row) => row.key === key)!;
      const markup = renderToStaticMarkup(<StationDetail station={station} hours={conveyor.hours} />);
      const warning = station.llm?.kind === "llm" ? station.llm.warnings[0] : "";
      expect(warning, key).toBe("엔진 연결 상태를 확인하세요.");
      const shown = station.reason ?? warning;
      expect(markup.split(shown).length - 1, key).toBe(1);
      expect(markup, key).not.toContain("cv-llmd-warn");
      expect(markup.match(/class="cv-reason"/g)?.length, key).toBe(1);
    }
  });

  it("lines numbers up: 처리량 numbers in one grid, holds in a table with right-aligned 건수·24시간 변화", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(same), holds: [{ reason: "second_review_split", count: 3_701, recent24h: 1_724 }] }));
    const second = conveyor.stations.find((row) => row.key === "second")!;
    expect(second.holds.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(<StationDetail station={second} hours={conveyor.hours} />);
    expect(markup).toContain('<dl class="cv-kpis">');
    expect(markup).toMatch(/<table class="cv-holds-table"><colgroup><col\/><col class="cv-c-num"\/><col class="cv-c-num"\/><\/colgroup><thead><tr><th scope="col">사유<\/th><th scope="col" class="cv-r">건수<\/th><th scope="col" class="cv-r">24시간 변화<\/th><\/tr><\/thead>/);
    expect(markup).toMatch(/<td class="cv-r cv-n">[\d,]+건<\/td>/);
    // 라벨 열은 작업마다 같은 dl(작업 · 설정 · 실제)
    expect(markup).toMatch(/<dl class="cv-kv cv-llmd-task" data-state="[a-z_]+"><dt class="cv-llmd-k">작업<\/dt>/);
  });

  it("splits 장애 대응 into 먼저 볼 것 (numbered) and a 조치 table — 종류 | 조치 | 되돌리기 with one of four same-width badges", () => {
    const conveyor = buildConveyor(conveyorInputs({ models: buildStationLlm(same) }));
    for (const station of [...conveyor.stations.map((row) => row.key), "human" as const]) {
      const response = stationResponse(station, conveyor, null);
      const markup = renderToStaticMarkup(<ResponsePanel steps={response.steps} checks={response.checks} controls={{ jobs: {}, csrf: null }} />);
      expect([...markup.matchAll(/<h4 class="cv-sec-h" id="rs-sec-[a-z]+">([^<]+)<\/h4>/g)].map((match) => match[1]), station).toEqual(["먼저 볼 것", "할 수 있는 조치"]);
      expect(markup, station).toContain('<thead><tr><th scope="col">종류</th><th scope="col">조치</th><th scope="col">되돌리기</th></tr></thead>');
      const badges = [...markup.matchAll(/<span class="rs-kind" data-kind="([a-z]+)" title="[^"]+">([^<]+)<\/span>/g)];
      expect(badges.length, station).toBe(response.steps.length);
      for (const [, kind, text] of badges) expect({ read: "보기", act: "작업", careful: "조심", manual: "화면 밖" }[kind], station).toBe(text);
      response.checks.forEach((check, index) => expect(markup, station).toContain(`<li><span class="rs-no" aria-hidden="true">${index + 1}</span><span class="rs-check">${check.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")}</span></li>`));
    }
  });

  it("finishes the 2차 check sentence (4차 지적: 3번이 잘려 보임)", () => {
    const checks = stationResponse("second", buildConveyor(conveyorInputs({ models: buildStationLlm(same) })), null).checks;
    expect(checks.every((check) => !/선$/.test(check))).toBe(true);
    expect(checks).toContain("2차 진행은 잡 관측이 아니라 2차 표(second_reviews) 생성 수로 봅니다 — 이 칸 「처리량」의 숫자와 그래프가 그 수입니다");
  });
});

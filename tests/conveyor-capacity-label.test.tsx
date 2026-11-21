import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn(), cancelAdminModelOperation: vi.fn() }));
import { PrototypeFlow } from "@/app/(operator)/admin/flow/PrototypeFlow";
import { StationDetail, TableView } from "@/app/(operator)/admin/flow/FlowBoard";
import { applyStationLlm, buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { buildStationLlm, RUNTIME_FRESH_MS, type LlmInputs } from "@/lib/operations/conveyor-llm";
import { textRankStatusFromCounts, textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { emptySearchHealth } from "@/lib/operations/search-health-model";
import { flowStageBadge } from "@/lib/operations/flow-stage-state";

const NOW = "2026-11-17T09:00:00.000Z";
const TASK = "product-search-verify";
function inputs(counts: Record<string, number> = { ranks: 1, "unusable.1.capacity": 2 }): LlmInputs {
  const status = textRankStatusFromCounts(TASK, NOW, counts);
  return { now: NOW, connections: [{ id: "supa", label: "supa-direct", kind: "api", baseUrl: "http://100.78.219.124:8000/v1", cliTool: null, hasKey: false, enabled: true }],
    rows: ["product-search-profile", TASK].map(task => ({ task, slot: 1, rank: 1, connectionId: "supa", model: "supa", enabled: true })),
    used: [], active: [], runtime: { [TASK]: { at: NOW, degraded: null, unusable: status.unusable.map(row => ({ ...row, text: textRankUnusableText(row.code) })) } } };
}
function conveyor(llm = inputs()) {
  const data: ConveyorInputs = { now: NOW, enabled: true, throughput: null, flow: null, hourly: null, human: null, progress: null,
    search: { ...emptySearchHealth(), pendingGeneration: 4, pendingVerification: 2 }, holds: [], rejected: 0, classification: null, sources: [], models: buildStationLlm(llm) };
  const result = buildConveyor(data);
  // 5,728 is the reported 24h total, not the conveyor ledger's separate 1h window.
  result.stations.find(station => station.key === "keywords")!.done24h = 5728;
  return result;
}
const keyword = (llm = inputs()) => conveyor(llm).stations.find(station => station.key === "keywords")!;
const task = (llm = inputs()) => {
  const station = buildStationLlm(llm).keywords;
  if (station.kind !== "llm") throw new Error("llm");
  return station.tasks.find(row => row.task === TASK)!;
};

describe("conveyor capacity observation regression (2026-11-17)", () => {
  it("reproduces the observed supa tick and renders the real home row as amber waiting", () => {
    const data = conveyor();
    const station = data.stations.find(row => row.key === "keywords")!;
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={{ jobs: {}, csrf: null }} editor={null} initialStage="keywords" />);
    if (process.env.CONVEYOR_CAPTURE_DIR) {
      mkdirSync(process.env.CONVEYOR_CAPTURE_DIR, { recursive: true });
      writeFileSync(`${process.env.CONVEYOR_CAPTURE_DIR}/home.html`, html);
      writeFileSync(`${process.env.CONVEYOR_CAPTURE_DIR}/row.html`, renderToStaticMarkup(<TableView data={data} />));
      writeFileSync(`${process.env.CONVEYOR_CAPTURE_DIR}/detail.html`, renderToStaticMarkup(<StationDetail station={station} hours={null} />));
    }
    expect(task().state).toBe("waiting");
    expect(task().head).toMatchObject({ model: "supa", where: "supa-direct" });
    expect(station).toMatchObject({ tone: "slow", status: "칸 부족 — 일부 대기", done24h: 5728 });
    expect(station.reason).toContain("포화(빈 칸 없음)");
    expect(flowStageBadge(station, [], null)).toMatchObject({ label: "칸 대기", tone: "amber" });
    expect(html).toContain("칸 부족 — 일부 대기");
    expect(html).not.toContain("모델 없음 — 일부 멈춤");
  });
  it.each(["capacity", "queue_full", "route_quota", "model_quota", "deferred", "rate_limited", "model_paused"])("treats %s as temporary even with historical completions and all_ranks_unusable", code => {
    const llm = inputs({ ranks: 1, [`unusable.1.${code}`]: 2 });
    llm.used = [{ routeId: TASK, provider: "local-direct", model: "supa", count: 20, lastAt: NOW }];
    llm.runtime![TASK].degraded = { code: "all_ranks_unusable", detail: null };
    expect(task(llm).state).toBe("waiting");
    expect(keyword(llm).tone).toBe("slow");
  });
  it("waits when one rank can recover, retaining the permanent failure on another rank", () => {
    const llm = inputs({ ranks: 2, "unusable.1.capacity": 2, "unusable.2.connection_key_missing": 1 });
    llm.connections!.push({ id: "remote", label: "remote", kind: "api", cliTool: null, hasKey: false, enabled: true });
    llm.rows!.push({ task: TASK, slot: 1, rank: 2, connectionId: "remote", model: "other", enabled: true });
    expect(task(llm).state).toBe("waiting");
    expect(task(llm).note).toContain("키가 없음");
    expect(keyword(llm).status).toBe("칸 부족 — 일부 대기");
  });
  it.each([false, true])("does not hide a permanent failure on the same rank (reverse=%s)", reverse => {
    const codes = reverse ? { "unusable.1.engine_no_key": 1, "unusable.1.capacity": 2 } : { "unusable.1.capacity": 2, "unusable.1.engine_no_key": 1 };
    expect(task(inputs({ ranks: 1, ...codes })).state).toBe("stuck");
  });
  it.each(["rank", "connection", "key"])("does not let a capacity tick mask a current disabled/missing %s", kind => {
    const llm = inputs();
    if (kind === "rank") llm.rows!.find(row => row.task === TASK)!.enabled = false;
    if (kind === "connection") llm.connections![0].enabled = false;
    if (kind === "key") llm.connections![0].baseUrl = "https://api.example.com/v1";
    expect(task(llm).state).toBe("stuck");
  });
  it("keeps no ranks distinct from permanent unusability", () => {
    const llm = inputs();
    llm.rows = llm.rows!.filter(row => row.task !== TASK);
    expect(task(llm).state).toBe("none");
    expect(task(inputs({ ranks: 1, "unusable.1.connection_key_missing": 1 })).state).toBe("stuck");
  });
  it("ignores stale temporary observations", () => {
    const llm = inputs();
    llm.runtime![TASK].at = new Date(Date.parse(NOW) - RUNTIME_FRESH_MS - 1).toISOString();
    expect(task(llm).state).toBe("idle");
  });
  it("prioritizes a separately stopped task over a waiting task", () => {
    const llm = inputs();
    llm.rows = llm.rows!.filter(row => row.task !== "product-search-profile");
    const station = keyword(llm);
    expect(station.status).toBe("모델 없음 — 일부 멈춤");
    expect(flowStageBadge(station, [], null)).toMatchObject({ tone: "red", label: "설정 필요" });
  });
  it("shows a full wait when both keyword tasks wait, and names deferred retries", () => {
    const llm = inputs();
    llm.runtime!["product-search-profile"] = structuredClone(llm.runtime![TASK]);
    expect(keyword(llm).status).toBe("칸 부족 — 대기");
    const retry = inputs({ ranks: 1, "unusable.1.deferred": 1 });
    expect(keyword(retry).status).toBe("일부 재시도 대기");
    expect(keyword(retry).reason).toContain("재시도 예약 중");
  });
  it("preserves independent incidents and explicit pauses", () => {
    const station = keyword();
    for (const tone of ["jam", "stop"] as const) {
      const incident = applyStationLlm({ ...station, tone, status: "기존 장애", reason: "별도 장애" }, station.llm);
      expect(incident).toMatchObject({ tone, status: "기존 장애", reason: "별도 장애" });
    }
    expect(flowStageBadge(station, [{ paused: false, lastError: false, execution: "stale" }], null)).toMatchObject({ tone: "red", label: "장애" });
  });
  it("keeps a usable fallback serving instead of marking the task waiting", () => {
    const llm = inputs();
    llm.rows!.push({ task: TASK, slot: 1, rank: 2, connectionId: "supa", model: "other", enabled: true });
    expect(task(llm).state).toBe("fallback");
  });
  it("applies temporary whole-pool failures only with matching current membership/revision", () => {
    const llm = inputs();
    const memberId = "11111111-1111-4111-8111-111111111111";
    llm.execution = [{ task: TASK, slot: 1, mode: "workload_pool", revision: 2, updatedAt: null,
      members: [{ memberId, position: 1, connectionId: "supa", model: "supa", deviceId: "supa" }] }];
    const runtime = llm.runtime![TASK];
    runtime.pool = { configRevision: 2, members: 1, served: {}, unusable: [{ memberId, code: "capacity", count: 2 }] };
    // Member counters alone cannot imply a whole-pool outage/wait.
    expect(task(llm).state).toBe("idle");
    runtime.degraded = { code: "all_ranks_unusable", detail: null };
    expect(task(llm).state).toBe("waiting");
    expect(keyword(llm).status).toBe("칸 부족 — 일부 대기");
    runtime.pool.unusable = [...runtime.pool.unusable, { memberId, code: "engine_no_key", count: 1 }];
    expect(task(llm).state).toBe("stuck");
    runtime.pool.configRevision = 1;
    expect(task(llm).state).toBe("idle");
  });

});

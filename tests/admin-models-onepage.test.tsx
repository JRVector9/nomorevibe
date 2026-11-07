import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/operation-actions", () => ({ probeAdminModel: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/unknown-review-actions", () => ({ closeUnknownReview: vi.fn(), requeueUnknownReviews: vi.fn() }));
import { LiveModels } from "@/app/(operator)/admin/models/LiveModels";
import { SummaryTiles } from "@/app/(operator)/admin/models/SummaryTiles";
import { ModelStageTable } from "@/app/(operator)/admin/models/ModelStageTable";
import { RefreshBar, ModelsTopBar } from "@/app/(operator)/admin/models/RefreshBar";
import { DevicesPanel, deviceProbeStatus } from "@/app/(operator)/admin/models/DevicesPanel";
import { UnknownReviewList } from "@/app/(operator)/admin/models/UnknownReviewList";
import { HelpersFold } from "@/app/(operator)/admin/models/HelpersFold";
import { buildModelCards, capacityAlarmChips, deviceServer, kstClock, leaseHost, modelRowGroups, modelRowStatus, probeIdentityOf, secondsAgoLabel, TEXT_STAGE_IDS,
  type CapacityAlarmSummary } from "@/lib/operations/admin-models-view";
import { parseProbeObservation, probeObservationKey, probeObservationValue, probeResultLabel, PROBE_KEY_MAX, type ProbeObservation } from "@/lib/operations/admin-models-probe";
import { buildAdminModelsObservation, type AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import type { CapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import type { CapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";
import { redesignObservation, redesignModels, redesignAssignments } from "./fixtures/admin-models-redesign";

const controls = { open: vi.fn(), disabled: false };
const now = "2026-10-31T05:00:00.000Z";
const thresholds = { reviewMaxRows: 50, reviewMaxAgeSeconds: 86_400, dispatchStuckSeconds: 1_800 };
const alarms = (over: Partial<CapacityAlarmSummary> = {}): CapacityAlarmSummary => ({ status: "ok", count: 0, oldestAgeSeconds: null, stuckDispatched: 0, alarmReasons: [], thresholds, ...over });
const lease = (role: string, over: Record<string, unknown> = {}) => ({ role, reason: "ready" as const, ownerInstanceId: `m3-${role}`, ownerKind: "primary", ownerRelease: "edc568651234abcd",
  epoch: 7, secondsUntilExpiry: 30, updatedAgoSeconds: 18, ...over });

describe("요약 타일 — 장부 집계·접수 모드", () => {
  it("접수 모드·정책 rev·epoch·관측 KST·장비 수와 요청 합계(진행 중·대기·확인 못함·1시간 성공/실패/철회)를 장부에서 센다", () => {
    const observation = redesignObservation(), cards = buildModelCards(observation, redesignModels, redesignAssignments);
    const html = renderToStaticMarkup(createElement(SummaryTiles, { observation, cards, controls, probes: {}, leases: [], readiness: null, alarms: null }));
    expect(html).toContain('data-mode="OPEN"'); expect(html).toContain("정책 rev <span class=\"font-mono tabular-nums\">7</span> · epoch <span class=\"font-mono tabular-nums\">1</span>");
    expect(html).toContain(`>${kstClock(observation.observedAt)}</span> KST`); expect(html).toContain(`장비 <span class="font-mono tabular-nums">${observation.groups.length}</span>대`);
    // fixture: reserved/dispatched 0, waiting 2, indeterminate 2, 1시간 성공 40 (12+28), 실패 0, 철회 0
    expect(html).toContain('data-sum="held">0<'); expect(html).toContain('data-sum="waiting">2<'); expect(html).toContain('data-sum="unknown">2<');
    expect(html).toContain('성공 <span class="font-mono text-up">40</span>'); expect(html).toContain('실패 <span class="font-mono text-down">0</span>'); expect(html).toContain('철회 <span class="font-mono">0</span>');
    expect(html).toContain(">접수 일시중지</button>"); expect(html).toContain("역할 lease 표를 읽지 못했습니다"); expect(html).toContain("장부 경보 요약을 읽지 못했습니다");
  });
  it("DRAINING 이면 재개 버튼과 노란 모드 표시, 장부를 못 읽었으면 접수 변경 버튼이 비활성이다", () => {
    const observation = { ...redesignObservation(), mode: "draining" as const }, cards = buildModelCards(observation, redesignModels);
    const html = renderToStaticMarkup(createElement(SummaryTiles, { observation, cards, controls, probes: {}, leases: [], readiness: "ok", alarms: alarms() }));
    expect(html).toContain('data-mode="DRAINING"'); expect(html).toContain(">접수 재개</button>"); expect(html).toContain("text-warn");
    const dead = renderToStaticMarkup(createElement(SummaryTiles, { observation: { ...observation, mode: null }, cards, controls, probes: {}, leases: [], readiness: null, alarms: null }));
    expect(dead).toMatch(/<button[^>]*disabled=""[^>]*>접수 일시중지<\/button>/);
  });
});

describe("경보 타일 — monitor 와 같은 문턱", () => {
  it("dispatch_stuck(전송 30분 초과)·review_backlog(>50)·review_stale(>24시간)만 경보 칩이고 아니면 없음으로 적는다", () => {
    expect(capacityAlarmChips(null)).toEqual([{ id: "ledger", tone: "warn", text: "장부 경보 미확인 · 장부를 읽지 못함" }]);
    const quiet = capacityAlarmChips(alarms({ count: 3, oldestAgeSeconds: 7_200, status: "review" }));
    expect(quiet.map(chip => chip.tone)).toEqual(["warn", "ok", "ok", "ok"]);
    expect(quiet.map(chip => chip.text)).toEqual(["장부 검토 대기", "dispatch_stuck 없음 · 문턱 30분", "review_backlog 없음 · 3/50", "review_stale 없음 · 가장 오래된 2시간 · 문턱 24시간"]);
    const firing = capacityAlarmChips(alarms({ status: "alarm", count: 61, oldestAgeSeconds: 90_000, stuckDispatched: 2, alarmReasons: ["dispatch_stuck", "review_backlog", "review_stale"] }));
    expect(firing.map(chip => chip.text)).toEqual(["장부 경보", "dispatch_stuck 2 · 전송 30분 초과", "review_backlog 61 > 50", "review_stale 가장 오래된 25시간 > 24시간"]);
    expect(firing.every((chip) => chip.tone === "bad")).toBe(true);
  });
  it("타일은 역할 준비(failover-readiness)·장부 상태·울린 사유·연결 안 된 장비를 칩으로, 문턱을 글자로 보인다 — monitor overall 은 저장되지 않아 쓰지 않는다", () => {
    const observation = redesignObservation(), cards = buildModelCards(observation, redesignModels, redesignAssignments);
    const supa = cards.find(card => card.equipment === "Supa")!, key = probeObservationKey(probeIdentityOf(supa));
    const probes: Record<string, ProbeObservation> = { [key]: { ...probeObservationValue(probeIdentityOf(supa), { listed: null, error: "모델 목록을 읽지 못했습니다." }, "manual"), key, observedAt: now } };
    const html = renderToStaticMarkup(createElement(SummaryTiles, { observation, cards, controls, probes, leases: [], readiness: "alarm",
      alarms: alarms({ status: "alarm", count: 61, stuckDispatched: 1, oldestAgeSeconds: 100, alarmReasons: ["dispatch_stuck", "review_backlog"] }) }));
    expect(html).toContain("역할 준비 <b>경보</b>"); expect(html).toContain("장부 경보"); expect(html).toContain("dispatch_stuck 1 · 전송 30분 초과"); expect(html).toContain("review_backlog 61 &gt; 50");
    expect(html).not.toContain("review_stale"); expect(html).toContain("Supa <b>연결 안 됨</b>"); expect(html).toContain("문턱: 전송 30분 · 검토 50행 · 24시간 · 검토 목록 61건");
    expect(html).not.toContain("monitor overall");
    const quiet = renderToStaticMarkup(createElement(SummaryTiles, { observation, cards, controls, probes: {}, leases: [], readiness: "ok", alarms: alarms() }));
    expect(quiet).toContain("역할 준비 <b>정상</b>"); expect(quiet).toContain("dispatch_stuck · review_backlog · review_stale 없음");
  });
});

describe("역할 lease 타일", () => {
  it("역할 5개를 host(M3/mini)·릴리스 8자·갱신 N초 전으로 보이고 예비·사유를 글자로 덧붙인다", () => {
    const leases = [lease("crawler"), lease("reviewer", { updatedAgoSeconds: 9 }), lease("publisher", { ownerInstanceId: "mini-publisher-standby", ownerKind: "standby", reason: "standby_active", updatedAgoSeconds: 31 }),
      lease("maintenance", { updatedAgoSeconds: 22 }), lease("text", { ownerInstanceId: null, ownerRelease: null, reason: "lease_missing", updatedAgoSeconds: null })];
    const html = renderToStaticMarkup(createElement(SummaryTiles, { observation: redesignObservation(), cards: [], controls, probes: {}, leases, readiness: "ok", alarms: alarms() }));
    for (const role of ["crawler", "reviewer", "publisher", "maintenance", "text"]) expect(html).toContain(`<dt class="font-mono">${role}</dt>`);
    expect(html).toContain(">M3</dd>"); expect(html).toContain("mini<span class=\"font-normal text-fg-2\"> 예비</span>"); expect(html).toContain("예비가 일함");
    expect(html).toContain(">edc56865</span> · 갱신 18초 전"); expect(html).toContain("갱신 31초 전"); expect(html).toContain("릴리스 없음"); expect(html).toContain("담당 기록 없음"); expect(html).toContain(">—</dd>");
    expect(leaseHost("m3-crawler")).toBe("M3"); expect(leaseHost("mini-text-standby")).toBe("mini"); expect(leaseHost(null)).toBeNull(); expect(leaseHost("osaka-x")).toBe("Oracle");
    expect(secondsAgoLabel(18)).toBe("18초 전"); expect(secondsAgoLabel(70)).toBe("1분 10초 전"); expect(secondsAgoLabel(22_320)).toBe("6시간 12분 전"); expect(secondsAgoLabel(null)).toBe("미확인");
  });
});

describe("연결 확인 관측 — 키·값·표시", () => {
  it("키는 probe:<provider>:<model>(경로 없음), 80자를 넘으면 해시로 줄인다 — 같은 장비·모델 슬롯은 어느 단계든 같은 키", () => {
    expect(probeObservationKey({ provider: "local-direct", model: "gpu3090:review" })).toBe("probe:local-direct:gpu3090:review");
    const long = probeObservationKey({ provider: "abcllm", model: "x".repeat(120) });
    expect(long.length).toBeLessThanOrEqual(PROBE_KEY_MAX); expect(long.startsWith("probe:#")).toBe(true);
    expect(probeObservationKey({ provider: "abcllm", model: "[supa] Qwen 3" })).toMatch(/^probe:#[0-9a-f]{32}$/);
    const card = buildModelCards(redesignObservation(), redesignModels)[0];
    expect(probeObservationKey(probeIdentityOf(card))).toBe(`probe:${card.definition!.provider}:${card.definition!.key}`);
  });
  it("값은 결과·출처·소요·경로만이고 비밀이 없다 — 저장된 행은 같은 모양으로만 읽는다", () => {
    const value = probeObservationValue({ routeId: "crawl-agent-review", provider: "abcllm", model: "q" }, { listed: true, listMs: 48.4, callBlocked: "짧은 시험 호출 차단" }, "manual");
    expect(value).toEqual({ kind: "model-probe", provider: "abcllm", model: "q", routeId: "crawl-agent-review", source: "manual", listed: true, listMs: 48, callMs: null, callBlocked: "짧은 시험 호출 차단", error: null, detail: null });
    expect(parseProbeObservation({ key: "probe:abcllm:q", value, observedAt: new Date(now) })).toMatchObject({ key: "probe:abcllm:q", observedAt: now, listed: true });
    expect(parseProbeObservation({ key: "service:app", value, observedAt: now })).toBeNull(); expect(parseProbeObservation({ key: "probe:abcllm:q", value: { bootId: "x" }, observedAt: now })).toBeNull();
    expect(probeResultLabel(value)).toEqual({ text: "목록 있음 48ms · 시험 호출 차단", tone: "ok" });
    expect(probeResultLabel({ listed: false, listMs: 1200, callMs: null, callBlocked: null, error: null })).toEqual({ text: "목록에 없음 1.2초", tone: "bad" });
    expect(probeResultLabel({ listed: null, listMs: null, callMs: null, callBlocked: null, error: "연결 거부" })).toEqual({ text: "연결 거부", tone: "bad" });
    expect(probeResultLabel({ listed: null, listMs: null, callMs: null, callBlocked: null, error: null })).toEqual({ text: "목록 미확인", tone: "na" });
  });
  it("표의 연결 확인 열은 저장된 관측을 「N초 전 · 수동/자동 · 결과」로, 기록이 없으면 「확인 기록 없음」으로 보이고 방금 받은 결과가 우선한다", () => {
    const observation = redesignObservation(), cards = buildModelCards(observation, redesignModels, redesignAssignments);
    const supa = cards.find(card => card.equipment === "Supa")!, mlx = cards.find(card => card.equipment === "M3 Ultra")!;
    const at = new Date(Date.parse(observation.observedAt!) - 28_000).toISOString();
    const probes: Record<string, ProbeObservation> = {
      [probeObservationKey(probeIdentityOf(supa))]: { ...probeObservationValue(probeIdentityOf(supa), { listed: true, listMs: 48, callBlocked: "차단" }, "auto"), key: "k1", observedAt: at, detail: "사람 위임 슬롯 · GET /models" },
    };
    const html = renderToStaticMarkup(createElement(ModelStageTable, { cards, observation, controls, probes, localProbes: {}, busy: null, onProbe: vi.fn() }));
    expect(html).toContain(">28초 전</span>"); expect(html).toContain("자동(렌더) · 사람 위임 슬롯 · GET /models"); expect(html).toContain("목록 있음 48ms · 시험 호출 차단");
    expect(html).toContain("확인 기록 없음"); expect(html).toContain("「연결 확인」 버튼 · GET /v1/models");
    const local = renderToStaticMarkup(createElement(ModelStageTable, { cards, observation, controls, probes, localProbes: { [mlx.id]: { listed: false, listMs: 35, observedAt: observation.observedAt!, source: "manual" } }, busy: null, onProbe: vi.fn() }));
    expect(local).toContain("수동(버튼)"); expect(local).toContain("목록에 없음 35ms"); expect(local).toContain('data-state="down"');
    const busy = renderToStaticMarkup(createElement(ModelStageTable, { cards, observation, controls, probes, localProbes: {}, busy: supa.id, onProbe: vi.fn() }));
    expect(busy).toContain("연결 확인 중…");
  });
  it("행 상태 순서: 확인 못함 → (확인 결과 없음/오류) 연결 안 됨 → 처리 중 → 접수 중지 → 보류 → 연결됨 → 근거 없으면 연결 안 됨", () => {
    const base = { unknown: 0, held: 0, waiting: 0, lastSuccessAt: now, mode: "open" as const };
    expect(modelRowStatus({ ...base, unknown: 1 })).toBe("unknown");
    expect(modelRowStatus({ ...base, probe: { listed: false } })).toBe("down"); expect(modelRowStatus({ ...base, probe: { listed: null, error: "x" } })).toBe("down");
    expect(modelRowStatus({ ...base, held: 1, mode: "draining" })).toBe("busy"); expect(modelRowStatus({ ...base, mode: "draining" })).toBe("paused");
    expect(modelRowStatus({ ...base, waiting: 2 })).toBe("hold"); expect(modelRowStatus(base)).toBe("connected");
    expect(modelRowStatus({ ...base, lastSuccessAt: null })).toBe("down"); expect(modelRowStatus({ ...base, lastSuccessAt: null, probe: { listed: true } })).toBe("connected");
  });
});

describe("text 경로 rowspan 구조", () => {
  const text = DEFAULT_MODEL_DEFINITIONS.find(row => row.key === "mlx:text")!;
  const route = (routeId: string) => ({ routeId, provider: text.provider, model: text.model, groupId: "mlx", providerBudgetId: "mlx" });
  it("abcllm 제공자 text 단계는 7개이고 한 모델의 7경로는 한 묶음(rowspan 7)으로 모델·장비·전송·점유·연결 확인·동작을 공유한다", () => {
    expect(TEXT_STAGE_IDS).toEqual(["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate", "product-search-profile", "product-search-verify", "crawl-tagline"]);
    const routes = TEXT_STAGE_IDS.map(route);
    const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { mlx: 2 }, groupLimits: { mlx: 2 }, poolLimits: { reviewer: 1, text: 2 }, weights: { first: 1, second: 1, background: 1 },
      maxWaiting: 8, queueTtlMs: 1000, reservationTtlMs: 1000, routes };
    const metrics: AdminModelMetrics[] = routes.map((row, index) => ({ ...row, succeeded1h: 10 + index, failed1h: index === 3 ? 1 : 0, withdrawn1h: 0, unclassified1h: 0, waiting: index === 3 ? 2 : 0,
      reserved: 0, dispatched: index === 0 ? 1 : 0, indeterminate: 0, lastSuccessAt: now }));
    const observation = buildAdminModelsObservation({ observedAt: now, control: { mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy), updatedAt: now }, metrics, requests: [] });
    const cards = buildModelCards(observation, DEFAULT_MODEL_DEFINITIONS, TEXT_STAGE_IDS.map(id => ({ id, label: id, models: [{ provider: text.provider, model: text.model }] })));
    expect(cards).toHaveLength(1);
    const groups = modelRowGroups(cards[0]);
    expect(groups).toHaveLength(1); expect(groups[0]).toMatchObject({ shared: true, held: 1, waiting: 2 }); expect(groups[0].stages.map(row => row.stage)).toEqual(TEXT_STAGE_IDS);
    const html = renderToStaticMarkup(createElement(ModelStageTable, { cards, observation, controls, probes: {}, localProbes: {}, busy: null, onProbe: vi.fn() }));
    expect(html.match(/rowspan="7"/gi)).toHaveLength(4); expect(html).toContain("text 경로 7개 공통"); expect(html).toContain("7경로 한 번에 적용");
    expect((html.match(/<tr /g) ?? []).length).toBe(7); expect(html).toContain(">1 / 2</span> <small class=\"text-fg-2\">공유</small>");
    // 단계마다 상태·대기·미확인·1시간·마지막 성공은 자기 값 — 첫 행 처리 중, 네 번째 행 보류
    expect(html.match(/data-state="busy"/g)).toHaveLength(2); expect(html.match(/data-state="hold"/g)).toHaveLength(2);
  });
  it("text 가 아닌 단계는 같은 모델이라도 행마다 자기 점유·동작을 갖고 재시작은 첫 행에서만, 연결 확인 결과는 공유한다", () => {
    const observation = redesignObservation();
    observation.rows.push({ ...observation.rows[1], routeId: "product-audit", succeeded1h: 5 });
    const cards = buildModelCards(observation, redesignModels, redesignAssignments), mlx = cards.find(card => card.equipment === "M3 Ultra")!;
    expect(modelRowGroups(mlx).map(group => group.shared)).toEqual([false, false]);
    const html = renderToStaticMarkup(createElement(ModelStageTable, { cards: [mlx], observation, controls, probes: {}, localProbes: {}, busy: null, onProbe: vi.fn() }));
    expect(html.match(/>모델 재시작<\/button>/g)).toHaveLength(2); expect(html).toContain("재시작은 첫 행에서"); expect(html.match(/>연결 확인<\/button>/g)).toHaveLength(3);
  });
});

describe("장비 표·검토 목록·접기·상단 띠", () => {
  it("장비 표는 장비 로더의 값(한도·보조 상한·점유·보조/상한·대기·역할 순위·물리 한도·판)과 등록부 주소, 저장된 연결 확인 상태를 보인다", () => {
    const view: CapacityDevicesAdminView = { mode: "open", epoch: 7, revision: 14, policyVerified: true, controlError: null, rowsError: null, statesError: null, lendingCount: 1, issues: [], audit: [],
      devices: [{ deviceId: "gpu3090", source: "table", enabled: true, version: 12, updatedBy: "jr", updatedAt: now, settings: { limitSlots: 4, secondaryCap: 2, idleMs: 60_000, reserveSlots: 0, physicalLimit: 4, note: null },
        defaults: { limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null }, policyRoutes: ["crawl-agent-review"],
        roles: [{ routeId: "crawl-agent-review", rank: 1, label: "1차 검수", inPolicy: true }, { routeId: "second-review", rank: 2, label: "2차 검수", inPolicy: true }],
        live: { source: "table", limitSlots: 4, active: 3, primaryBusy: true, secondaryActive: 1, secondaryBound: 2, lending: true, waiting: 3, waitingPrimary: 1 }, issues: [] },
      { deviceId: "supa", source: "policy_fallback", enabled: true, version: null, updatedBy: null, updatedAt: null, settings: { limitSlots: 2, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null },
        defaults: { limitSlots: 2, secondaryCap: 2, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null }, policyRoutes: [], roles: [], live: null, issues: [] }] };
    const supaKey = probeObservationKey({ provider: "abcllm", model: "supa:review" });
    const probes: Record<string, ProbeObservation> = { [supaKey]: { ...probeObservationValue({ provider: "abcllm", model: "supa:review" }, { listed: null, error: "연결 거부" }, "manual"), key: supaKey, observedAt: now } };
    const html = renderToStaticMarkup(createElement(DevicesPanel, { view, models: DEFAULT_MODEL_DEFINITIONS, probes }));
    expect(html).toContain('<caption class="sr-only">장비별 한도와 점유</caption>'); expect(html).toContain("장비 <span class=\"font-mono tabular-nums\">2</span>대");
    expect(html).toContain("<code class=\"font-semibold\">gpu3090</code>"); expect(html).toContain("100.77.43.63:8090"); expect(html).toContain("<b>3</b> / 4"); expect(html).toContain("1 / 2"); expect(html).toContain("빌려 쓰는 중");
    expect(html).toContain("1차 검수"); expect(html).toContain("2차 검수"); expect(html).toContain(">v12</td>"); expect(html).toContain("우선 역할 바쁨");
    expect(html).toContain("정책 대체"); expect(html).toContain('data-state="down"'); expect(html).toContain("border-l-down");
    expect(deviceServer("gpu3090-qwen", DEFAULT_MODEL_DEFINITIONS)).toEqual({ name: "gpu3090", hosts: ["100.77.43.63:8090"] });
    expect(deviceProbeStatus("supa", DEFAULT_MODEL_DEFINITIONS, probes)).toBe("down"); expect(deviceProbeStatus("gpu3090", DEFAULT_MODEL_DEFINITIONS, {})).toBeNull();
  });
  it("확인 못함 목록은 요청마다 #rv-<requestId> 앵커·사유·KST 시각·근거·검토 완료 폼을 보인다", () => {
    const queue: CapacityReviewQueue = { truncated: false, error: null, groups: [{ routeId: "human-deepseek-review", count: 1 }], items: [{ requestId: "7e2c1a90-0000-4000-8000-000000000001", routeId: "human-deepseek-review", provider: "local-direct", model: "deepseek-v4.1-flash-1017",
      groupId: "m3", providerBudgetId: "m3", workKey: "candidate:42", logicalWorkKey: null, ownerInstanceId: "m3-reviewer", dispatchedAt: "2026-10-31T05:17:52.000Z", markedAt: "2026-10-31T05:19:55.000Z",
      reason: "client_timeout", oldPolicy: false, localEndRecorded: true }] };
    const html = renderToStaticMarkup(createElement(UnknownReviewList, { queue }));
    expect(html).toContain('id="rv-7e2c1a90-0000-4000-8000-000000000001"'); expect(html).toContain("<code title=\"7e2c1a90-0000-4000-8000-000000000001\">7e2c1a90</code>");
    expect(html).toContain("기한 초과(client_timeout)"); expect(html).toContain("전송 <span class=\"font-mono tabular-nums\">14:17:52</span>"); expect(html).toContain("14:19:55"); expect(html).toContain("mlx-lm 은 취소 없음");
    expect(html).toContain("로컬 종료 기록 있음"); expect(html).toContain(">검토 완료</button>"); expect(html).toContain('for="note-7e2c1a90-0000-4000-8000-000000000001"');
    expect(renderToStaticMarkup(createElement(UnknownReviewList, { queue: { items: [], truncated: false, error: null, groups: [] } }))).toContain("검토할 미확인 호출이 없습니다");
  });
  it("지원하는 단계에는 전체 건수와 다시 대기열에 넣기 버튼을, 미지원 단계에는 안내만 보인다", () => {
    const item = { requestId: "7e2c1a90-0000-4000-8000-000000000002", routeId: "crawl-publish-classify", provider: "abcllm",
      model: "opencode-go/deepseek-v4.1-flash", groupId: "m3", providerBudgetId: "m3", workKey: "bg:publication-classify:abc:def",
      logicalWorkKey: "bg:publication-classify:abc", ownerInstanceId: "m3-publisher", dispatchedAt: "2026-11-06T12:57:27.934Z",
      markedAt: "2026-11-06T12:58:00.000Z", reason: "transport_unknown" as const, oldPolicy: false, localEndRecorded: false };
    const html = renderToStaticMarkup(createElement(UnknownReviewList, { queue: { items: [item], truncated: true, error: null,
      groups: [{ routeId: "crawl-publish-classify", count: 160 }, { routeId: "human-deepseek-review", count: 2 }] } }));
    expect(html).toContain("160"); expect(html).toContain("발행 분류");
    expect(html).toContain("다시 대기열에 넣기"); expect(html).toContain("목록은 오래된 100건만 표시합니다");
    expect(html).toContain("아직 지원하지 않는 단계");
  });
  it("접기 1(도우미·감시자·배정 출처·새 잡)은 요약을 summary 에 두고 실제 값만 그린다 — 없는 출처는 — 로", () => {
    const html = renderToStaticMarkup(createElement(HelpersFold, { helpers: null, contracts: [{ routeId: "crawl-agent-review", model: "q", host: null, transport: "gateway" }],
      assignment: { flag: true, sources: { ai1: "table", ai2: "legacy" }, error: null },
      jobs: { error: null, rows: [{ name: "held-qwen-retry", intervalMs: 60_000, registered: true, nextInSeconds: -40, lastRunAgoSeconds: 20, lastSuccessAgoSeconds: 20, runs: 3, lastError: null },
        { name: "split-confirm", intervalMs: 60_000, registered: false, nextInSeconds: null, lastRunAgoSeconds: null, lastSuccessAgoSeconds: null, runs: null, lastError: null }] } }));
    expect(html).toContain('<details id="assign"'); expect(html).toContain("감시자 신호 없음 · 도우미 — · 플래그 MODEL_ASSIGNMENT_TABLE 켜짐 · 새 잡 2개 중 1개 등록");
    expect(html).toContain("도우미 상태를 읽지 못했습니다"); expect(html).toContain(">표</span>"); expect(html).toContain("설정(legacy)"); expect(html).toContain("관리 계약 1"); expect(html).toContain("CLI · 계약 없음");
    expect(html).toContain("<code>held-qwen-retry</code>"); expect(html).toContain(">등록됨</span>"); expect(html).toContain("40초 뒤"); expect(html).toContain("마지막 실행 20초 전 · 3회");
    expect(html).toContain(">미등록</span>"); expect(html).toContain("스케줄러 먼저 배포");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });
  it("페이지는 접기 2개(#assign·#ref)·2열 구획·상단 띠·PageStamp 를 두고 숫자를 지어내지 않는다", () => {
    const source = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/page.tsx"), "utf8");
    expect(source).toContain("<PageStamp />");
    // The shared workspace header owns refresh and navigation; a second timer used to overlap it and overflow the viewport.
    expect(source).not.toContain("<ModelsTopBar");
    expect(readFileSync(path.resolve(__dirname, "../app/(operator)/admin/AdminShell.tsx"), "utf8")).toContain("<LiveBar ");
    expect(source).toContain('<details id="ref"'); expect(source).toContain("<HelpersFold ");
    expect(source).toContain("[grid-template-columns:minmax(0,7fr)_minmax(0,5fr)]"); expect(source).toContain("readProbeObservations()"); expect(source).toContain("recordAutoProbes(");
    expect(source).toContain("roleOverview()"); expect(source).toContain("readModelCapacityUnknowns("); expect(source).toContain("readCatalogJobRegistration()");
  });
  it("상단 띠는 마지막 갱신(KST 서버 렌더 시각)·30초마다 자동·다음 N초·수동 새로고침을 보이고 하위 화면 링크를 둔다", () => {
    const html = renderToStaticMarkup(createElement(ModelsTopBar, { renderedAt: "2026-10-31T05:31:56.000Z" }));
    expect(html).toContain("마지막 갱신"); expect(html).toMatch(/<time datetime="2026-10-31T05:31:56.000Z" class="font-mono font-semibold tabular-nums">14:31:56<\/time>/i);
    expect(html).toContain("30초마다 자동"); expect(html).toContain("다음 30초"); expect(html).toContain(">수동 새로고침</button>"); expect(html).toContain('href="/admin/models/devices"');
    for (const href of ["#assign", "#devices", "#ref", "/admin/models/contracts", "/admin/models/limits", "/admin/models/assignments"]) expect(html).toContain(`href="${href}"`);
    expect(renderToStaticMarkup(createElement(RefreshBar, { renderedAt: "bad", periodMs: 10_000 }))).toContain("--:--:--");
  });
  it("LiveModels 는 타일·표·범례·처리량 접기를 한 구획에 그리고 장부 오류면 띠와 경고만 그린다", () => {
    const html = renderToStaticMarkup(createElement(LiveModels, { observation: redesignObservation(), models: redesignModels, assignments: redesignAssignments, probes: {}, leases: [], readiness: null, alarms: alarms() }));
    expect(html).toContain('aria-label="요약"'); expect(html).toContain(">단계 × 모델</h2>"); expect(html).toContain('aria-label="범례"'); expect(html).toContain("단계별 건당 처리량");
    expect(html).toContain("모델 슬롯 <span class=\"font-mono\">3</span>개");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/operation-actions", () => ({ probeAdminModel: vi.fn(), changeAdminModelAdmission: vi.fn() }));
import { buildAdminModelsObservation, unavailableAdminModels, elapsedModelTime } from "@/lib/operations/admin-models-observation";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { LiveModels } from "@/app/(operator)/admin/models/LiveModels";

const at = "2026-10-29T01:00:00.000Z";
const route = { routeId: "product-translate", provider: "abcllm", model: "M1", groupId: "m1", providerBudgetId: "m1" };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { m1: 1 }, groupLimits: { m1: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 },
  maxWaiting: 8, queueTtlMs: 1000, reservationTtlMs: 1000, routes: [route] };
const metrics = { ...route, succeeded1h: 3, failed1h: 1, withdrawn1h: 2, unclassified1h: 4,
  waiting: 2, reserved: 1, dispatched: 0, indeterminate: 1, lastSuccessAt: at };
const request = { ...route, requestId: "29877f65-9f95-4efb-88f9-aea5f39a28b2", state: "indeterminate", queuedAt: at,
  stateSince: at, dispatchedAt: at, reservedUntil: null, ownerInstanceId: "m1-worker", localEndRecorded: true };
function snapshot(metricsRows: unknown[] = [metrics], requests: unknown[] = [request]) {
  return { observedAt: "2026-10-29T02:00:00.000Z", control: { mode: "open" as const, epoch: 1, revision: 2,
    policy, policyHash: modelCapacityPolicyHash(policy), updatedAt: at }, metrics: metricsRows, requests };
}
describe("admin-models DB 관측 표시", () => {
  it("미확인·예약은 기한과 무관하게 같은 그룹의 점유에 포함한다", () => {
    const result = buildAdminModelsObservation(snapshot());
    expect(result.groups).toEqual([{ groupId: "m1", held: 2, limit: 1 }]);
    expect(result.requests[0]).toMatchObject({ requestId: request.requestId, state: "indeterminate" });
    expect(result.rows[0]).toMatchObject({ succeeded1h: 3, failed1h: 1, withdrawn1h: 2, unclassified1h: 4 });
  });
  it("같은 모델의 예전 그룹과 현재 그룹을 합쳐 숨기지 않는다", () => {
    const result = buildAdminModelsObservation(snapshot([metrics, { ...metrics, groupId: "old", reserved: 0, indeterminate: 1 }]));
    expect(result.groups.find(row => row.groupId === "old")).toEqual({ groupId: "old", limit: null, held: 1 });
    expect(result.rows).toHaveLength(2);
  });
  it("정책 해시 검증에 실패하면 상한이나 0건을 추정하지 않는다", () => {
    const raw = snapshot(); raw.control.policyHash = "0".repeat(64);
    const result = buildAdminModelsObservation(raw);
    expect(result.policyVerified).toBe(false);
    expect(result.globalLimit).toBeNull();
    expect(result.groups[0].limit).toBeNull();
    expect(result.requests).toHaveLength(1);
  });
  it("호출 이력이 없는 정식 경로도 표시하고 요청 100건 제한을 알린다", () => {
    const result = buildAdminModelsObservation(snapshot([], Array.from({ length: 101 }, () => request)));
    expect(result.rows[0]).toMatchObject({ ...route, succeeded1h: 0 });
    expect(result.truncated).toBe(true); expect(result.requests).toHaveLength(100);
  });
  it("DB 실패를 요청 없음으로 렌더링하지 않는다", () => {
    const html = renderToStaticMarkup(createElement(LiveModels, { observation: unavailableAdminModels() }));
    expect(html).toContain('role="alert"'); expect(html).toContain("0건으로 간주하지 않습니다");
    expect(html).not.toContain("현재 남아 있는 요청이 없습니다"); expect(html).not.toContain("접수 일시중지");
  });
  it("미확인 M1 요청·상태 발생·경과·로컬 종료와 접수 상태를 그린다", () => {
    const html = renderToStaticMarkup(createElement(LiveModels, { observation: buildAdminModelsObservation(snapshot()) }));
    for (const label of ["OPEN", "미확인 · indeterminate", request.requestId, "상태 경과 1시간 0분", "로컬 호출 종료 기록 있음", "접수 일시중지", "요청 종료·해제"])
      expect(html).toContain(label);
    expect(html).not.toContain(">접수 재개</button>");
  });
  it("미래 시각은 음수 경과로 표시하지 않는다", () => {
    expect(elapsedModelTime(at, null)).toBe("미확인"); expect(elapsedModelTime(at, "2026-10-29T00:59:00.000Z")).toBe("0초");
  });
});

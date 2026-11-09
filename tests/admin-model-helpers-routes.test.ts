import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unavailableAdminModels, type AdminModelMetrics, type AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { buildHelperRoutesView } from "@/lib/operations/admin-model-helpers-routes";
import type { DisplayConnection } from "@/lib/operations/llm-display";

// 보조 모델 화면의 「보조 작업 경로」 표(2026-11-09 시안) — local-assist-* 경로를 경로 × 장비 한 줄로, 마지막 사용은 장부 관측의 24시간 안 마지막 성공.
const NOW = "2026-11-09T00:00:00.000Z";
const metric = (over: Partial<AdminModelMetrics> & Pick<AdminModelMetrics, "routeId" | "groupId">): AdminModelMetrics => ({ provider: "local-direct", model: "qwen3.8-flash-next",
  providerBudgetId: "local", succeeded1h: 0, failed1h: 0, withdrawn1h: 0, unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null, ...over });
const observation = (rows: AdminModelMetrics[], configured = rows): AdminModelsObservation => ({ ...unavailableAdminModels(), error: null, observedAt: NOW, mode: "open",
  policyVerified: true, rows, configuredRoutes: configured.map(({ routeId, provider, model, groupId, providerBudgetId }) => ({ routeId, provider, model, groupId, providerBudgetId })) });
const connections: DisplayConnection[] = [{ id: "c1", label: "gpu3090-qwen", kind: "api", cliTool: null, deviceId: "gpu3090", enabled: true, models: [{ id: "qwen3.8-flash-next", maxModelLen: null }] }];

describe("보조 작업 경로 표", () => {
  it("보조 경로만 모으고, 이름은 routeDisplayLabel(「보조 · 」 뗌)·서버는 연결 이름; 상태는 실패만 > 미확정 > 대기 > 실행 중 > 사용 > 쉼", () => {
    const rows = [
      metric({ routeId: "local-assist-uptime-gpu3090-qwen", groupId: "gpu3090", lastSuccessAt: "2026-11-08T20:00:00.000Z" }),
      metric({ routeId: "local-assist-uptime-gpu3090-qwen", groupId: "gpu3090", model: "other", lastSuccessAt: "2026-11-08T22:00:00.000Z", dispatched: 1 }),
      metric({ routeId: "local-assist-news-gpu3090-qwen", groupId: "gpu3090" }),
      metric({ routeId: "local-assist-decision_audit-m3-deepseek", groupId: "m3-mlx", failed1h: 2 }),
      metric({ routeId: "local-assist-repo_move-gpu3090-qwen", groupId: "gpu3090", indeterminate: 3, waiting: 1 }),
      metric({ routeId: "crawl-agent-review", groupId: "gpu3090", succeeded1h: 9 }),
    ];
    const view = buildHelperRoutesView({ observation: observation(rows, rows.slice(0, 4)), connections });
    expect(view.readable).toBe(true);
    expect(view.rows.map(row => [row.label, row.server, row.status, row.level])).toEqual([
      ["소식", "gpu3090-qwen", "쉼", "idle"],
      ["연결 확인", "gpu3090-qwen", "실행 중 1", "ok"],
      ["저장소 이동", "gpu3090-qwen", "미확정 3건", "warn"],
      ["판정 감사", "m3-mlx", "실패만 2건(1시간)", "bad"],
    ]);
    const uptime = view.rows.find(row => row.label === "연결 확인")!;
    expect(uptime.lastSuccessAt).toBe("2026-11-08T22:00:00.000Z");
    expect(uptime.models).toEqual(["other", "qwen3.8-flash-next"]);
    expect(view.rows.find(row => row.label === "저장소 이동")!.inPolicy).toBe(false);
    expect(view.idle).toBe(1);
    expect(view.lastSuccessAt).toBe("2026-11-08T22:00:00.000Z");
  });

  it("장부를 못 읽으면 줄을 0 으로 꾸미지 않고 까닭을 준다", () => {
    const view = buildHelperRoutesView({ observation: unavailableAdminModels(), connections: null });
    expect(view).toMatchObject({ readable: false, rows: [], lastSuccessAt: null });
    expect(view.error).toContain("읽지 못해");
  });

  it("화면은 대시보드와 같은 장부 관측(처리량 표본 없이)을 읽고, 24시간 창 밖은 「24시간 안 없음」으로 적는다", () => {
    const page = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/helpers/page.tsx"), "utf8");
    expect(page).toContain("readAdminModelsObservation({ throughput: false })");
    expect(page).toContain("24시간 안 없음");
    expect(page).toContain('import "./helpers.css"');
  });
});

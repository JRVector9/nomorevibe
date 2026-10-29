import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
import { ModelOpsPanel, ModelOpsProgress } from "@/app/(operator)/admin/models/ModelOpsPanel";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";
const command = { id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release" as const,
  targetId: "161d7780-5b1f-4ce8-be8d-baed927b28e8", reason: "local test", confirmed: true as const };
it("버튼 이름과 진행 단계·실패 위치·사유를 표시한다", () => {
  const state = { ...initialOpsState(command, "admin"), status: "blocked" as const, step: "verify-stop" as const,
    code: "termination_evidence_missing", steps: { prepare: "done" as const, drain: "done" as const, stop: "done" as const, "verify-stop": "blocked" as const } };
  const html = renderToStaticMarkup(createElement(ModelOpsProgress, { state }));
  for (const label of ["요청 종료·해제", "접수 중지 (DRAIN)", "종료 근거 확인", "원래 설정 복원", "멈춘 단계", "termination_evidence_missing", command.id]) expect(html).toContain(label);
});
it("M1 sudo를 사람 작업으로 표시하고 미완료 복구 중 접수 재개를 비활성화한다", () => {
  const state = { ...initialOpsState(command, "admin"), status: "manual" as const, step: "stop" as const, steps: { prepare: "done" as const, drain: "done" as const }, code: "human_on_device_sudo_stop_restore_required" };
  expect(renderToStaticMarkup(createElement(ModelOpsProgress, { state }))).toContain("사람이 장비에서 할 일");
  const html = renderToStaticMarkup(createElement(ModelOpsPanel, { mode: "draining", requests: [], models: [], initialStates: [state] }));
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>접수 재개<\/button>/);
  expect(html).not.toContain("재시작할 모델");
});
it("UUID 작업 식별자와 실제 감사 행 번호를 구분해 표시한다", () => {
  const state = { ...initialOpsState(command, "admin"), auditId: 20940, status: "completed" as const };
  const html = renderToStaticMarkup(createElement(ModelOpsProgress, { state }));
  expect(html).toContain("감사 번호: #20940");
  expect(html).toMatch(/<details><summary>자세히<\/summary>/);
});

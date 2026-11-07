import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
import { ModelOpsPanel, ModelOpsProgress } from "@/app/(operator)/admin/models/ModelOpsPanel";
import { AdmissionControl } from "@/app/(operator)/admin/models/AdmissionControl";
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
it("DRAIN 인계 작업은 OPEN 대신 인계 단계를 보이고 끝나도 접수가 DRAIN임을 알린다", () => {
  const steps = { prepare: "done", drain: "done", stop: "done", "verify-stop": "done", release: "done", restore: "done", "verify-restored": "done", handoff: "done" } as const;
  const state = { ...initialOpsState(command, "jr"), status: "completed" as const, step: "handoff" as const, finalAdmission: "draining" as const, steps };
  const html = renderToStaticMarkup(createElement(ModelOpsProgress, { state }));
  expect(html).toContain("DRAIN 유지·다음 절차 인계 · 완료");
  expect(html).toContain("이 작업은 끝나도 접수를 DRAIN으로 둡니다");
  expect(html).not.toContain("접수 재개 (OPEN)");
  const plain = renderToStaticMarkup(createElement(ModelOpsProgress, { state: { ...initialOpsState(command, "jr"), status: "completed" as const } }));
  expect(plain).toContain("접수 재개 (OPEN)"); expect(plain).not.toContain("DRAIN으로 둡니다");
});
it("대시보드 접수 카드(compact): 끝나지 않은 요청은 한 줄로 단추가 잠긴 까닭을 말하고, 단계·끝난 요청은 접어 둔다", () => {
  // 운영(2026-11-08)과 같은 상태 — 「요청 종료·해제」 감사 #21956 이 운영 실행기를 기다리는 동안 접수 단추가 잠긴다
  const pending = { ...initialOpsState(command, "jr"), auditId: 21956 };
  const done = { ...initialOpsState({ ...command, id: "0b9e2f61-1111-4a3c-8c11-6d2f0e7c1a22", action: "admission-open", targetId: "model-capacity" }, "jr"),
    status: "completed" as const, steps: { prepare: "done" as const, open: "done" as const }, step: "open" as const, auditId: 21890 };
  const html = renderToStaticMarkup(createElement(AdmissionControl, { mode: "open", opsStates: [pending, done], readOnly: false, readable: true }));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // 카드 뿌리는 Tailwind flex 가 아니다 — prototype.css 의 `.admin-prototype .flex { align-items: center }` 가 단추·진행 상자를 가운데로 모았다
  expect(html.startsWith('<div class="llm-ops-runner">')).toBe(true);
  const describedBy = html.match(/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"[^>]*>DRAIN 으로 · 접수 중지<\/button>/)?.[1];
  expect(describedBy).toBe(`ops-pending-${command.id}`);
  expect(html).toContain(`<p role="status" id="${describedBy}">`);
  expect(text).toContain("처리 안 된 운영 요청: 요청 종료·해제 · 감사 #21956 · 운영 실행기 대기 — 이 요청이 끝나기 전에는 접수 단추를 쓸 수 없습니다.");
  expect(html).toMatch(/<details><summary>단계 0\/8 완료 · 자세히<\/summary><ol><li>준비·대상 고정 · 대기<\/li>/);
  expect(html).toContain(`작업 ID ${command.id}`);
  expect(text).toMatch(/끝난 운영 요청 1건 접수 재개 · 감사 #21890 · 완료/);
  // 긴 안내 문단은 카드에 두지 않는다(확인 대화상자로 옮겼다)
  expect(html).not.toContain("확인 후 작업 큐에 접수합니다");
  // 운영 요청이 없으면 단추가 열리고 까닭 줄이 없다
  const idle = renderToStaticMarkup(createElement(AdmissionControl, { mode: "open", opsStates: [], readOnly: false, readable: true }));
  expect(idle).toMatch(/<button type="button" class="button">DRAIN 으로 · 접수 중지<\/button>/);
  expect(idle).not.toContain("처리 안 된 운영 요청");
});
it("compact: 준비 단계에서 멈춘 요청(경계를 잡지 않음)은 단추를 잠그지 않고 「멈춘 운영 요청」과 사유를 보인다", () => {
  const stopped = { ...initialOpsState(command, "jr"), status: "manual" as const, code: "human_on_device_sudo_stop_restore_required", auditId: 21000 };
  const html = renderToStaticMarkup(createElement(ModelOpsPanel, { compact: true, mode: "open", requests: [], models: [], initialStates: [stopped],
    renderControls: controls => createElement("button", { type: "button", disabled: controls.disabled, "aria-describedby": controls.blockedBy }, "접수 일시중지") }));
  expect(html).toMatch(/<button type="button">접수 일시중지<\/button>/);
  expect(html).toContain('data-level="bad"');
  expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("멈춘 운영 요청: 요청 종료·해제 · 감사 #21000 · 중단");
  expect(html).toContain("사람이 장비에서 할 일");
});

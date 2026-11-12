import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildModelUnifiedFixture } from "@/lib/operations/model-unified-fixture";
import { unifiedAssistDraft, unifiedAssistForm, unifiedConcurrencyForm } from "@/lib/operations/model-unified-controls";
const save = vi.hoisted(() => ({ assist: vi.fn(), concurrency: vi.fn(), apply: vi.fn(), clear: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/assist-actions", () => ({ saveAssistControlAction: save.assist }));
vi.mock("@/app/(operator)/admin/models/limits/actions", () => ({ saveRuntimeSettingsGroup: save.concurrency }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ applyAiTaskImportAction: save.apply, clearUnreadAiTaskRanksAction: save.clear }));
import { UnifiedAssistDrawer, UnifiedConcurrencyDrawer, UnifiedOperationsControls } from "@/app/(operator)/admin/models/unified/UnifiedOperationsControls";

describe("통합 운영 설정의 기존 저장 계약", () => {
  it("보강 방식·보내기·반영의 의존 관계를 보존하고 기존 판으로 CAS폼을 보낸다", () => {
    const control = { ...buildModelUnifiedFixture().assist.controls[0], revision: 17 };
    expect(unifiedAssistDraft({ mode: "off", dispatchEnabled: true, applyEnabled: true })).toEqual({ mode: "off", dispatchEnabled: false, applyEnabled: false });
    expect(unifiedAssistDraft({ mode: "shadow", dispatchEnabled: true, applyEnabled: true }).applyEnabled).toBe(false);
    expect(unifiedAssistDraft({ mode: "confirm", dispatchEnabled: false, applyEnabled: true }).applyEnabled).toBe(false);
    const form = unifiedAssistForm(control, { mode: "confirm", dispatchEnabled: true, applyEnabled: true });
    expect(Object.fromEntries(form)).toEqual({ task: "uptime", revision: "17", mode: "confirm", dispatch: "on", apply: "on" });
    const off = unifiedAssistForm(control, { mode: "off", dispatchEnabled: true, applyEnabled: true });
    expect(off.has("dispatch")).toBe(false); expect(off.has("apply")).toBe(false);
  });
  it("동시 업무의 현재값·원래값·덮어쓰기·기본값복원을 기존 sparse patch와 같은 필드로 보낸다", () => {
    const control = buildModelUnifiedFixture().concurrency;
    const field = control.fields[0], other = control.fields[1];
    const form = unifiedConcurrencyForm({ ...control, revision: 42 }, { [field.path]: "3" }, { [other.path]: true });
    expect(form.get("expectedRevision")).toBe("42"); expect(form.get("group")).toBe("jobs");
    expect(form.get(`value:${field.path}`)).toBe("3"); expect(form.get(`initial:${field.path}`)).toBe("2");
    expect(form.get(`stored:${field.path}`)).toBe("1"); expect(form.get(`reset:${other.path}`)).toBe("on");
    expect(form.get(`value:${other.path}`)).toBe(other.input);
    expect(form.has(`reset:${field.path}`)).toBe(false);
  });
  it("보강과 동시 업무 상세는 조회만으로 저장하지 않으며 읽기 전용을 모두 잠근다", () => {
    const data = buildModelUnifiedFixture();
    const assist = renderToStaticMarkup(<UnifiedAssistDrawer control={data.assist.controls[0]} readOnly onClose={() => {}} />);
    expect(assist).not.toContain('role="status"');
    expect(assist).toContain('aria-label="연결 확인 보내기"');
    expect(assist).toContain("관리자 확인 필수(끌 수 없음)");
    expect(assist).toMatch(/<button[^>]*disabled=""[^>]*>변경 확인<\/button>/);
    const limits = renderToStaticMarkup(<UnifiedConcurrencyDrawer control={data.concurrency} readOnly onClose={() => {}} />);
    expect(limits).toContain('max="4"'); expect(limits).toContain('href="/admin/models/limits"');
    expect(limits).toMatch(/<button[^>]*disabled=""[^>]*>변경 확인<\/button>/);
    for (const action of Object.values(save)) expect(action).not.toHaveBeenCalled();
  });
  it("표면은 접힌 간단한 행만 그리며 입력 폼·중첩 접힘·서랍을 저절로 열지 않는다", () => {
    const html = renderToStaticMarkup(<UnifiedOperationsControls data={buildModelUnifiedFixture()} readOnly={false} />);
    expect(html.match(/<details\b/g)).toHaveLength(3); expect(html.match(/class="mu-assist-row"/g)).toHaveLength(4);
    expect(html).not.toContain("<input"); expect(html).not.toContain("<select"); expect(html).not.toContain("<dialog");
    expect(html).toContain("계획 보기 →"); expect(html).toContain("기록 정리 →");
    for (const action of Object.values(save)) expect(action).not.toHaveBeenCalled();
  });
  it("가져오기 deep link는 실제 계획을 서랍에서 보이고 계획 없음·읽기 실패·쓰기없음을 구분한다", () => {
    const data = buildModelUnifiedFixture();
    const planned = renderToStaticMarkup(<UnifiedOperationsControls data={data} readOnly openImport />);
    expect(planned).toContain('aria-labelledby="mu-import-title"'); expect(planned).toContain("가져올 항목 없음");
    expect(planned).not.toContain("적용(쓰기"); expect(planned).toContain("읽기 전용 미리보기");
    const missing = renderToStaticMarkup(<UnifiedOperationsControls data={{ ...data, importPreview: null }} readOnly openImport />);
    expect(missing).toContain("계획을 아직 읽지 않았습니다"); expect(missing).not.toContain("가져올 항목 없음");
    const failed = renderToStaticMarkup(<UnifiedOperationsControls data={{ ...data, importPreview: { ...data.importPreview!, error: "read_failed", plan: null } }} readOnly openImport />);
    expect(failed).toContain('role="alert"'); expect(failed).toContain("계획을 만들지 못했습니다: read_failed");
  });
  it("옛 순위 조회가 실패하면 없음으로 꾸미지 않고 기록 정리 버튼을 잠근다", () => {
    const html = renderToStaticMarkup(<UnifiedOperationsControls data={{ ...buildModelUnifiedFixture(), retired: [], retiredReadable: false, retiredError: "read_failed" }} readOnly={false} />);
    expect(html).toContain('role="alert"'); expect(html).toContain("옛 순위 기록을 읽지 못했습니다(read_failed)");
    expect(html).not.toContain("남은 옛 순위 기록 없음"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>기록 정리 →<\/button>/);
  });
});

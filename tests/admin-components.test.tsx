import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmAction } from "@/app/admin/components/ConfirmAction";
import { ScrollTable } from "@/app/admin/components/ScrollTable";
import { StatusDot } from "@/app/admin/components/StatusDot";
import { AdminToastProvider, resultError, resultToast } from "@/app/admin/components/Toast";
import { ADMIN_THEME_SCRIPT } from "@/app/admin/components/ThemeToggle";

/** 관리자 공통 부품(2026-10-08 UX 감사) — 상호작용은 브라우저에서, 여기서는 그려지는 모양과 순수 규칙만 본다 */
describe("상태 점", () => {
  it("모양(data-state)과 글자를 함께 낸다", () => {
    expect(renderToStaticMarkup(<StatusDot state="failed" />)).toBe(
      '<span class="admin-status" data-state="failed"><span class="admin-status-mark" aria-hidden="true"></span>실패</span>');
  });
  it("글자를 바꿔도 상태 이름은 읽힌다", () => {
    const html = renderToStaticMarkup(<StatusDot state="delayed" label="12분 늦음" />);
    expect(html).toContain("12분 늦음");
    expect(html).toContain('<span class="admin-vh"> (지연)</span>');
  });
});

describe("가로 스크롤 표", () => {
  it("키보드로 닿는 이름 붙은 영역", () => {
    expect(renderToStaticMarkup(<ScrollTable label="요청 목록"><table /></ScrollTable>)).toBe(
      '<div class="admin-table-scroll" role="region" aria-label="요청 목록" tabindex="0"><table></table></div>');
  });
});

describe("확인 창", () => {
  it("닫혀 있으면 버튼만 보이고 창 속은 그리지 않는다", () => {
    const html = renderToStaticMarkup(<ConfirmAction title="3건을 내립니다" targets={["a", "b", "c"]} confirmLabel="3건 내리기"
      onConfirm={() => null} trigger={(open) => <button type="button" onClick={open}>내린다</button>} />);
    expect(html).toContain("<button type=\"button\">내린다</button>");
    expect(html).toMatch(/<dialog class="admin-confirm" data-tone="danger" aria-labelledby="[^"]+-title"><\/dialog>/);
    expect(html).not.toContain("3건 내리기");
  });
});

describe("알림", () => {
  it("알림 자리는 처음부터 aria-live 로 놓인다", () => {
    expect(renderToStaticMarkup(<AdminToastProvider><main /></AdminToastProvider>)).toBe(
      '<main></main><section class="admin-toasts" aria-label="알림" aria-live="polite"></section>');
  });
  it("서버 액션 결과에서 실패 사유를 꺼낸다", () => {
    expect(resultError(null)).toBeNull();
    expect(resultError(undefined)).toBeNull();
    expect(resultError({ ok: true })).toBeNull();
    expect(resultError({ message: "시작했습니다" })).toBeNull();
    expect(resultError({ error: "권한이 없습니다" })).toBe("권한이 없습니다");
    expect(resultError({ issues: ["가", "나"] })).toBe("가 · 나");
    expect(resultError("실패")).toBe("실패");
  });
  it("성공·실패·일부 실패를 톤으로 가른다", () => {
    const undo = { run: () => null };
    expect(resultToast(null, { message: "승인함 · auto-claude-skills", undo })).toEqual({ tone: "ok", message: "승인함 · auto-claude-skills", undo });
    expect(resultToast({ error: "권한이 없습니다" }, "승인함")).toEqual({ message: "권한이 없습니다", tone: "error" });
    expect(resultToast({ done: 3, failed: [{ slug: "x", message: "없음" }] } as never, { message: "3건 내림", undo }))
      .toEqual({ message: "3건 내림 · 1건 실패", tone: "warn", undo: undefined });
    expect(resultToast({ message: "감사를 시작했습니다" })).toEqual({ tone: "ok", message: "감사를 시작했습니다" });
    expect(resultToast(null)).toEqual({ tone: "ok", message: "처리했습니다" });
  });
});

describe("테마 스크립트", () => {
  it("라이트·다크만 달고 저장이 막혀도 멈추지 않는다", () => {
    expect(ADMIN_THEME_SCRIPT).toContain('localStorage.getItem("nmv-admin-theme")');
    expect(ADMIN_THEME_SCRIPT).toContain('setAttribute("data-admin-theme",t)');
    expect(ADMIN_THEME_SCRIPT).toMatch(/^try\{.*\}catch\(e\)\{\}$/);
  });
});

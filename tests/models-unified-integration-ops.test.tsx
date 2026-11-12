import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildModelUnifiedFixture, MODEL_UNIFIED_FIXTURE_RECENT } from "@/lib/operations/model-unified-fixture";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ applyAiTaskImportAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/assist-actions", () => ({ saveAssistControlAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/limits/actions", () => ({ saveRuntimeSettingsGroup: vi.fn() }));
import { UnifiedOperations } from "@/app/(operator)/admin/models/unified/UnifiedOperations";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("통합 화면 운영 설정과 최근 변경", () => {
  it("접힌 기존 제어·CAS·가져오기·옛 기록 정리를 유지하고 실제 기록 전체로 연결한다", () => {
    const data = buildModelUnifiedFixture();
    const html = renderToStaticMarkup(<UnifiedOperations data={data} readOnly={false} recent={MODEL_UNIFIED_FIXTURE_RECENT} />);
    for (const id of ["operations", "assist-controls", "concurrency", "cleanup", "import", "retired-records", "audit"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/<details[^>]+open=/);
    expect(text(html)).toContain("보내기 0 / 4개");
    expect(html).toContain('name="task" value="uptime"');
    expect(html).toContain('name="revision" value="1"');
    expect(text(html)).toContain("확인 필수(끌 수 없음)");
    expect(html).toContain('value:jobs.second-review.consumerConcurrency');
    expect(html).toContain('value:jobs.crawl-publish.classifierConcurrency');
    expect(html).toContain('href="/admin/models/limits"');
    expect(html).toContain('href="/admin/models?import=plan#import"');
    expect(html).toContain('aria-label="한국어 소개 번역 · 직접 경로 옛 순위 기록 1개 지우기"');
    expect(html).toContain('href="/admin/models/history#audit"');
    expect(html.match(/class="mu-recent-row"/g)).toHaveLength(3);
    expect(text(html)).toContain("gpu3090-qwen · 쓰는 작업 변경");
    expect(text(html)).toContain("21:35");
  });
  it("읽기 전용에서는 보강·동시 업무·가져오기·옛 기록 지우기를 잠근다", () => {
    const html = renderToStaticMarkup(<UnifiedOperations data={buildModelUnifiedFixture()} readOnly recent={[]} />);
    expect(html).not.toContain('name="dispatch"');
    expect(html).not.toContain('name="apply"');
    expect(html).toContain('<fieldset disabled="" class="mu-import">');
    expect(html).not.toContain('옛 순위 기록 1개 지우기"');
    expect(text(html)).toContain("읽기 전용");
  });
  it("기록 읽기 실패를 기록 없음으로 보이지 않고 저장 실패의 사유와 실제 시각을 보인다", () => {
    const fixture = buildModelUnifiedFixture();
    const failed = renderToStaticMarkup(<UnifiedOperations data={{ ...fixture, changes: { rows: [], error: "unavailable", more: false } }} readOnly />);
    expect(failed).toContain('role="alert"'); expect(text(failed)).toContain("최근 변경을 읽지 못했습니다");
    const rows = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, createdAt: new Date("2026-11-12T12:35:00Z"), actor: "JR", action: "ai-task-models-save",
      target: "first-review#1", ok: false, error: "revision_mismatch", detail: {} })) as never;
    const actual = renderToStaticMarkup(<UnifiedOperations data={{ ...fixture, changes: { rows, error: null, more: true } }} readOnly />);
    expect(actual.match(/class="mu-recent-row"/g)).toHaveLength(3);
    expect(text(actual)).toContain("revision_mismatch · JR"); expect(actual).not.toContain("[object Object]");
  });
});

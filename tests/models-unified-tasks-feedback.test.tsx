import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnifiedTaskImpact, UnifiedTaskResult, type UnifiedTaskSaveResult } from "@/app/(operator)/admin/models/unified/tasks/UnifiedTaskFeedback";
import { unifiedTaskImpactSummary, unifiedTaskSavesConfirmed } from "@/lib/operations/model-unified-task-view";

const saved = (kind: UnifiedTaskSaveResult["kind"], patch: Partial<UnifiedTaskSaveResult> = {}): UnifiedTaskSaveResult => ({
  kind, ok: true, message: "서버 저장 확인", issues: [], warnings: [], ...patch,
});
const result = (results: readonly UnifiedTaskSaveResult[], expected: readonly ("execution" | "ranks")[]) => renderToStaticMarkup(<UnifiedTaskResult
  results={results} expected={expected} mode="workload_pool" chain="확인된 모델 2칸 + 다른 모델 1칸" homeHref="/admin/flow?stage=first#sp-models" onClose={() => undefined} />);

describe("unified task confirmation and confirmed result", () => {
  it("requires every reviewed action in order before claiming the draft was applied", () => {
    expect(unifiedTaskSavesConfirmed([], [])).toBe(false);
    expect(unifiedTaskSavesConfirmed([saved("execution")], ["execution", "ranks"])).toBe(false);
    expect(unifiedTaskSavesConfirmed([saved("ranks"), saved("execution")], ["execution", "ranks"])).toBe(false);
    expect(unifiedTaskSavesConfirmed([saved("execution"), saved("ranks", { ok: false })], ["execution", "ranks"])).toBe(false);
    expect(unifiedTaskSavesConfirmed([saved("execution", { issues: ["응답 상태가 불확실합니다."] })], ["execution"])).toBe(false);
    expect(unifiedTaskSavesConfirmed([saved("execution"), saved("ranks")], ["execution", "ranks"])).toBe(true);

    const html = result([saved("execution"), saved("ranks")], ["execution", "ranks"]);
    expect(html).toContain("배정 설정을 저장했습니다.");
    expect(html).toContain("저장 확인은 실제 호출 성공과 다릅니다.");
    expect(html).toContain("확인된 모델 2칸 + 다른 모델 1칸");
    expect(html).toContain('href="/admin/flow?stage=first#sp-models"');
    expect(html).toContain("홈 배정 확인 →");
    expect(html).toContain("저장 내역");
  });

  it("keeps partial and uncertain failures visible without an applied-chain preview", () => {
    const partial = result([saved("execution"), saved("ranks", { ok: false, issues: ["CAS 판이 바뀌어 순위를 저장하지 못함"] })], ["execution", "ranks"]);
    expect(partial).toContain("일부 변경만 저장됐습니다.");
    expect(partial).toContain('<p role="alert">CAS 판이 바뀌어 순위를 저장하지 못함</p>');
    expect(partial).not.toContain("배정 설정을 저장했습니다.");
    expect(partial).not.toContain("확인된 모델 2칸");
    expect(partial).not.toContain("홈 배정 확인 →");
    const uncertain = result([saved("execution", { ok: false, unconfirmed: true, issues: ["저장 응답을 확인하지 못했습니다. 다시 누르기 전에 최근 기록을 확인하세요."] })], ["execution"]);
    expect(uncertain).toContain("저장 응답을 확인하지 못했습니다.");
    expect(uncertain).toContain("실행 방식 저장 여부 미확인");
    expect(uncertain).not.toContain("저장 못 함");
    expect(uncertain).not.toContain("ut-after");
    const partialUnknown = result([saved("execution"), saved("ranks", { ok: false, unconfirmed: true })], ["execution", "ranks"]);
    expect(partialUnknown).toContain("나머지도 적용됐을 수 있으니");
    expect(partialUnknown).not.toContain("일부 변경만 저장됐습니다");
    expect(partialUnknown).not.toContain("확인된 저장만");
  });

  it("keeps successful-write warnings visible above the primary completion actions", () => {
    const html = result([saved("execution", { warnings: ["저장됐지만 한도가 부족해 실행을 기다립니다."] })], ["execution"]);
    expect(html).toContain('<p class="ut-callout ut-warn" role="alert">저장됐지만 한도가 부족해 실행을 기다립니다.</p>');
    expect(html.indexOf("한도가 부족해")).toBeLessThan(html.indexOf("ut-editor-foot"));
    expect(html.indexOf("ut-editor-foot")).toBeLessThan(html.indexOf("ut-save-receipts"));
  });

  it("keeps capacity and blocking warnings outside the closed full-impact disclosure", () => {
    const full = "모델 A: 이 단계에 4칸 · 지금 2칸 중 2칸 사용(가득 참) · 같은 모델을 쓰는 다른 단계 3개(소개 · 번역 · 검색)와 칸을 나눕니다 — 장비 한도 2칸보다 많이 적어 장비 한도가 먼저 걸립니다";
    const compact = unifiedTaskImpactSummary(full);
    expect(compact).toContain("지금 2칸 중 2칸 사용(가득 참)");
    expect(compact).toContain("장비 한도 2칸보다 많이 적어 장비 한도가 먼저 걸립니다");
    expect(compact).not.toContain("소개 · 번역 · 검색");
    const html = renderToStaticMarkup(<UnifiedTaskImpact taskLabel="1차 AI 검수" deviceNotes={["장비 전체 상세 공유 내역"]} help={<div>기존 모델별 칸 수 도움말</div>} impact={[
      { tone: "warn", text: full }, { tone: "bad", text: "1순위가 비면 이 단계가 멈춥니다(no_task_models)." }, { tone: "info", text: "모델 B: 다른 단계와 함께 쓰는 내역" },
    ]} />);
    const outside = html.slice(0, html.indexOf("<details"));
    expect(outside).toContain(compact);
    expect(outside).toContain("1순위가 비면 이 단계가 멈춥니다");
    expect(outside).not.toContain("모델 B: 다른 단계와 함께 쓰는 내역");
    expect(html).toContain("영향 자세히");
    expect(html).toContain(full);
    expect(html).toContain("장비 전체 상세 공유 내역");
    expect(html.indexOf("기존 모델별 칸 수 도움말")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).not.toContain("<details open");
  });
});

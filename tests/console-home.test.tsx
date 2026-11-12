import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/status/job-control-actions", () => ({ controlJobAction: vi.fn() }));

import { ConsoleHome } from "@/app/(operator)/admin/flow/ConsoleHome";
import { consoleFixtureRead } from "./fixtures/console-home";

const csrf = { token: "fixture-token", expiresAt: 9_999_999_999 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("console home", () => {
  const html = renderToStaticMarkup(<ConsoleHome data={consoleFixtureRead()} csrf={csrf} />);
  const plain = text(html);

  it("puts the strip first, then the tasks, then the flow (tasks come first on a narrow screen)", () => {
    expect(plain).toContain("접수 열림 · 08:26부터 발행 6/시간 24시간 발행 1,374 공개 78,919 워커 6/6 정상");
    expect(html.indexOf('class="ch-strip"')).toBeLessThan(html.indexOf('id="ch-tasks-title"'));
    expect(html.indexOf('id="ch-tasks-title"')).toBeLessThan(html.indexOf('id="ch-flow-title"'));
  });

  it("lists the tasks in the four groups with the fixture's counts", () => {
    expect(plain).toContain("지금 할 일 11건");
    const groups = [...html.matchAll(/<li class="ch-grp" data-group="(\w+)">([^<]+)<span>(\d+)<\/span>/g)].map(match => [match[1], match[2], match[3]]);
    expect(groups).toEqual([["stop", "멈춤", "2"], ["odd", "평소와 다름", "1"], ["pile", "쌓임 · 오래 걸리는 순", "5"], ["tidy", "정리", "3"]]);
    const titles = [...html.matchAll(/<li class="ch-task"[^>]*><i aria-hidden="true"><\/i><div><h3>([^<]+)<\/h3>/g)].map(match => match[1]);
    expect(titles).toEqual(["AI 1차가 거의 멈췄습니다", "소개 검수가 8일째 멈춰 있습니다", "규칙 심사 보류가 갑자기 늘었습니다", "공개 번역이 쌓입니다",
      "사유 번역이 쌓입니다", "키워드 검수가 쌓입니다", "사람 확인이 줄지 않습니다", "감사 거절이 쌓여 있습니다", "LG EXAONE이 자주 거절합니다", "M1max를 아직 안 씁니다",
      "순위에 같은 모델이 두 번 들어 있습니다"]);
    expect(html).toContain('<li class="ch-task" data-tone="bad" data-rule="stage-stalled">');
    expect(plain).toContain("워커가 틱마다 후보 2건을 「이미 처리 중」으로 건너뛰고 끝납니다. gpu3090-qwen은 5칸이 모두 비어 있습니다.");
  });

  it("links every button to an existing screen or the existing job control", () => {
    expect(html).toContain('href="/admin/flow?tab=detail&amp;stage=first#prototype-selected-stage">단계 열기</a>');
    // 재개 — 운영센터와 같은 작업 제어 폼(사유 필수)
    expect(html).toMatch(/<details class="ch-job"><summary class="button small primary">재개<\/summary><form[^>]*>.*재개 사유.*이 작업 재개<\/button>/);
    expect(html).toContain('href="/admin/models/tasks#execution-product-translate-1">모델 붙이기</a>');
    expect(html).toContain('href="/admin/review?tab=human&amp;stage=agreed">묶음 보기</a>');
    expect(html).toContain('href="/admin/audit">묶음 보기</a>');
    expect(html).not.toMatch(/사유 남기고 유지|그대로 두기/);
  });

  it("falls back to the job detail when the inline control cannot be offered", () => {
    const readOnly = renderToStaticMarkup(<ConsoleHome data={consoleFixtureRead()} csrf={null} />);
    expect(readOnly).not.toContain("ch-job");
    expect(readOnly).toContain('href="/admin/status?tab=jobs&amp;job=product-intro-check">재개</a>');
  });

  it("draws the flow table from the conveyor, with the after-publish group", () => {
    expect(html).toContain('<table class="ch-table"><colgroup><col/><col style="width:132px"/>');
    expect(plain).toContain("AI 1차 거의 멈춤 857 3 /시간");
    expect(html).toContain('<span class="ch-st" data-tone="bad"><i aria-hidden="true"></i>거의 멈춤</span>');
    expect(plain).toContain("공개 게시 중 — 6 /시간 공개 78,919");
    expect(plain).toMatch(/공개 뒤 한국어 소개 일감 없음 0 0 \/5분 — 공개 번역 쌓임 187,380 17 \/5분 — 사유 번역 쌓임 78,863 21 \/5분 — 소개 검수 멈춤 2,143 0 \/5분 —/);
    expect(html.match(/<svg class="ch-spark"/g)).toHaveLength(7);
  });

  it("leaves the change-watch slot empty unless the next piece fills it", () => {
    expect(html).not.toContain("바꾼 것 지켜보기");
    const filled = renderToStaticMarkup(<ConsoleHome data={consoleFixtureRead()} csrf={null} changeWatch={<section id="watch">바꾼 것 지켜보기</section>} />);
    expect(filled.indexOf('id="ch-flow-title"')).toBeLessThan(filled.indexOf('id="watch"'));
  });

  it("says there is nothing to do with the last check time", () => {
    const read = consoleFixtureRead();
    const quiet = renderToStaticMarkup(<ConsoleHome csrf={null} data={{ ...read, inputs: { ...read.inputs, now: "2026-11-12T00:00:00.000Z",
      conveyor: { stations: [], human: null, holdsByReason: [] }, jobs: [], takedown: { count: 0, overdue: 0 }, audit: { open: 0, overdue: 0, oldestWaitDays: null },
      progress: { stages: [] }, connections: [], ranks: [], pools: [], ledger: [] }, conveyor: null }} />);
    expect(text(quiet)).toContain("할 일 없음 · 마지막 확인 11-12 09:00");
    expect(text(quiet)).toContain("셀 수 없음 · 사람 확인");
    expect(text(quiet)).toContain("흐름을 셀 수 없음");
    expect(text(quiet)).toContain("접수 열림 · 08:26부터 발행 셀 수 없음");
  });
});

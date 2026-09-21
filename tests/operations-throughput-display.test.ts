import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ThroughputStage } from "@/lib/operations/throughput-model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ThroughputStrip } from "@/app/admin/status/ThroughputStrip";

const stage: ThroughputStage = {
  key: "second", label: "AI 2차", unit: "표", completed1m: 3, completed5m: 7,
  waiting: 12, oldestMinutes: 75, enabled: true, errors5m: null,
  queueNote: "심사를 기다리는 표", detail: "최근 완료한 심사 표를 셉니다.", status: "processing",
};
const render = (value: ThroughputStage) => renderToStaticMarkup(createElement(ThroughputStrip, {
  snapshot: { measuredAt: "2026-09-22T01:02:03.000Z", stages: [value] },
}));

it("preserves refresh controls and reports unavailable data instead of fabricated zero throughput", () => {
  const html = renderToStaticMarkup(createElement(ThroughputStrip, { snapshot: null }));
  expect(html).toContain("처리 속도를 불러오지 못했습니다");
  expect(html).toContain("자동 갱신");
  expect(html).not.toContain("건/1분");
});

it("distinguishes completed votes, five-minute average and oldest queue age", () => {
  const html = render(stage);

  expect(html).toContain("<strong>3</strong><span>표/1분</span>");
  expect(html).toContain("5분 평균 <b>1.4</b> 표/분");
  expect(html).toContain("12<span>표</span>");
  expect(html).toContain("심사를 기다리는 표");
  expect(html).toContain("1시간 15분");
  expect(html).toContain("10:02:03");
  expect(html).toContain("자동 갱신");
  expect(html).toContain("처리 기록 있음");
  expect(html).not.toContain("5분 내 오류 기록");
});

it("shows recorded errors and an uncertain queue age without implying no errors or no wait", () => {
  const html = render({ ...stage, errors5m: 2, oldestMinutes: null, status: "stalled" });

  expect(html).toContain("정체 의심");
  expect(html).toContain("확인할 단계");
  expect(html).toContain("시각 미확인");
  expect(html).toContain("5분 내 오류 기록");
  expect(html).toContain('data-error="true">2<span>표</span>');
});

it("keeps paused stages distinct from bottlenecks and shows an empty queue explicitly", () => {
  const html = render({ ...stage, enabled: false, waiting: 0, oldestMinutes: null, status: "paused" });

  expect(html).toContain("일시 중지");
  expect(html).toContain("대기 없음");
  expect(html).not.toContain("확인할 단계");
});

it("distinguishes an empty idle stage from a stage waiting for its next run", () => {
  const empty = render({ ...stage, completed1m: 0, completed5m: 0, waiting: 0, oldestMinutes: null, status: "idle" });
  const waiting = render({ ...stage, completed1m: 0, completed5m: 0, oldestMinutes: 1, status: "idle" });

  expect(empty).not.toContain("처리 대기");
  expect(waiting).toContain("처리 대기");
});

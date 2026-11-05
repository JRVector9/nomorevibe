import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
import { PrototypeFlow, requestCount } from "@/app/(operator)/admin/flow/PrototypeFlow";
import { PrototypeModels } from "@/app/(operator)/admin/models/PrototypeModels";
import { buildConveyor } from "@/lib/operations/conveyor-model";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { redesignObservation, redesignModels, redesignAssignments } from "./fixtures/admin-models-redesign";

const data = buildConveyor({ now: "2026-11-04T15:00:00.000Z", enabled: true, throughput: null, flow: null, hourly: null, human: null,
  progress: null, search: null, holds: null, rejected: null, classification: null, sources: [] });
const controls = { jobs: {}, csrf: null };

describe("original HTML prototype layout with real-loader contracts", () => {
  it("counts all six user-request sources and keeps any missing source unknown", () => {
    const desk = { decisions: { remaining: 0, failed: 0, done: 0, items: [], sections: [], clear: ["takedown", "introRequest", "feedback", "makerReply", "contact"].map(key => ({ key, title: key, href: "/admin/requests" })) } };
    expect(requestCount(desk, 3)).toBe(3);
    expect(requestCount(desk, null)).toBeNull();
    expect(requestCount({ decisions: { ...desk.decisions, clear: desk.decisions.clear.slice(1) } }, 3)).toBeNull();
  });
  it("keeps the nine-card home flow, selected-stage layout and three branches without inventing metrics", () => {
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={controls} editor={null} userRequests={{ count: null, knownCount: 7, failed: 1 }} />);
    expect(html).toContain('class="grid four home-kpis"');
    expect(html.match(/class="flow-card"/g)).toHaveLength(9);
    expect(html.match(/class="branch"/g)).toHaveLength(3);
    const stageTable = html.match(/id="prototype-stage-observations"[^]*?<\/tbody>/)?.[0]?.split("<tbody>")[1] ?? "";
    expect(stageTable.match(/<tr>/g)).toHaveLength(9);
    expect(stageTable).toContain(">공개 완료</button>");
    for (const className of ["flow-phases", "flow-grid", "stage-detail", "detail-summary", "control-box", "worker-grid"]) expect(html).toContain(`class="${className}"`);
    expect(html).toContain("확인된 7건 · 일부 조회 실패");
    expect(html).toContain('href="/admin/products?tab=quality"');
    expect(html).toContain('class="mini-stat"><span>장부 전송 중</span><b class="mono">—</b>');
    expect(html).toContain('<details class="panel" id="flow-advanced">');
    expect(html).not.toMatch(/모델 A|Orbit Notes|가상 관측|시안 상황|NaN|undefined/);
  });

  it("places streamed overview and SNS flow in their own slots without duplicating overview metrics", () => {
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={controls} editor={null}
      overviewContent={<section>전체 프로젝트 집계와 발행 추이</section>}
      socialContent={<section>SNS 수집·발행 흐름</section>} />);
    expect(html).toContain("전체 프로젝트 집계와 발행 추이");
    expect(html).not.toContain('class="grid four home-kpis"');
    expect(html.match(/class="flow-card"/g)).toHaveLength(9);
    expect(html.indexOf("SNS 수집·발행 흐름")).toBeGreaterThan(html.indexOf('id="prototype-selected-stage"'));
    expect(html.indexOf("SNS 수집·발행 흐름")).toBeLessThan(html.indexOf("먼저 처리할 일"));
  });

  it.each([
    ["judge", "/admin/review?tab=all&stage=judge"], ["first", "/admin/review?tab=all&stage=ai"],
    ["second", "/admin/review?tab=all&stage=second"], ["publish", "/admin/review?tab=publish&stage=publish"],
  ] as const)("opens the actual %s stage queue from selected-stage detail", (stage, target) => {
    const html = renderToStaticMarkup(<PrototypeFlow data={{ ...data, bottleneck: stage }} desk={null} controls={controls} editor={null} />);
    const detail = html.match(/class="stage-detail"[^]*?<\/aside>/)?.[0];
    expect(detail).toContain(`href="${target.replaceAll("&", "&amp;")}"`);
    expect(html).toContain('href="/admin/review?tab=human"');
  });
  it("links translation diagnosis to the real translation workspace", () => {
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={controls} editor={null} tab="diagnostics" />);
    expect(html).toContain('href="/admin/products?tab=translations"');
    expect(html).not.toContain('filter=translations-failed');
  });

  it("does not borrow a different station's spark when a station has no hourly measurement", () => {
    const measured = { ...data, stations: data.stations.map(station => station.key === "publish" ? { ...station, spark: [1, 2, 3] } : station) };
    const html = renderToStaticMarkup(<PrototypeFlow data={measured} desk={null} controls={controls} editor={null} />);
    // The published KPI, publish station and public result share the publication series. The other stages have none.
    expect(html.match(/<svg class="spark"/g)).toHaveLength(3);
  });

  it.each(["diagnostics", "changes"])("renders home %s using the prototype's own panel composition", tab => {
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={controls} editor={null} tab={tab} />);
    expect(html).toContain('class="stat ');
    expect(html).toContain('class="panel-head"');
    expect(html).not.toContain('class="flow-grid"');
    expect(html).toContain(tab === "diagnostics" ? "수집 소스별 상태" : "최근 바뀐 설정·제어");
  });

  it("renders the original LLM summary and seven-column representative table from ledger observations", () => {
    const html = renderToStaticMarkup(<PrototypeModels observation={redesignObservation()} models={redesignModels} assignments={redesignAssignments} contracts={[]} readOnly />);
    expect(html).toContain('class="grid four"');
    expect(html).toContain("작업 × 실제 사용 모델 · 대표 6개");
    for (const heading of ["설정 모델 / 출처", "실제 모델", "실행 / 한도", "성공 / 실패", "결과 미확정 · 사람 검토", "호출 기록 · 업무 결과 대조"]) expect(html).toContain(heading);
    expect(html).not.toContain('class="models-stage-table');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>신규 호출 접수 중지<\/button>/);
    expect(html).toContain("이 검토 행 자체는 슬롯을 점유하지 않음");
    const missing = renderToStaticMarkup(<PrototypeModels observation={unavailableAdminModels()} models={[]} assignments={[]} contracts={[]} readOnly />);
    expect(missing).toContain("최근 실행을 읽지 못했습니다.");
    expect(missing).not.toContain('class="stat-value mono">0</div>');
  });

  it.each(["tasks", "capacity", "connections", "history"])("keeps LLM %s in the prototype layout and links to original editors", tab => {
    const html = renderToStaticMarkup(<PrototypeModels observation={unavailableAdminModels()} models={[]} assignments={[]} contracts={[]} tab={tab} readOnly />);
    expect(html).toContain('class="panel-head"');
    expect(html).toContain(`tab=${tab}&amp;advanced=1`);
    if (tab === "tasks") { expect(html).toContain(`전체 ${AI_TASKS.length}개 작업`); expect(html).toContain("순위를 읽지 못함"); expect(html).toContain('href="/admin/models/tasks#tasks"'); }
    if (tab === "capacity") { expect(html).toContain("장비·물리 그룹"); expect(html).toContain("경로별 토큰·기한·묶음"); }
    if (tab === "connections") expect(html).toContain("연결 목록을 읽지 못했습니다.");
    if (tab === "history") expect(html).toContain("열린 요청을 읽지 못했습니다.");
    expect(html).not.toMatch(/모델 A|REQ-941|가상 데이터|NaN|undefined/);
  });
});

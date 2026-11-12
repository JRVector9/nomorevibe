import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";
import { modelFixtureInput, modelFixtureRead } from "./fixtures/model-console";
import { modelDuplicateAssignments, modelRowsFor, modelUsageText } from "@/app/(operator)/admin/models/console/model-console-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiConnectionAction: vi.fn(), readAiConnectionModelsAction: vi.fn(), deleteAiConnectionAction: vi.fn(),
  hideAiConnectionModelAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn(), saveAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveDeviceRowAction: vi.fn(), saveCapacityDevice: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));

import { ModelConsole, ModelDetail } from "@/app/(operator)/admin/models/console/ModelConsole";
import { ModelAttachForm } from "@/app/(operator)/admin/models/console/ModelAttachForm";
import { ModelAddFlow } from "@/app/(operator)/admin/models/new/ModelAddFlow";
import { ModelSettingsForm } from "@/app/(operator)/admin/models/console/ModelSettingsForm";

describe("unified model inventory", () => {
  it("uses compact low-usage text locally while preserving known zero, unknown, and the shared production formatter", () => {
    const row = modelFixtureRead().view.rows.find(entry => entry.id === "conn-lg-exaone")!;
    expect(row.utilizationText).toBe("1% 미만");
    expect(modelUsageText(row)).toBe("<1%");
    expect(modelUsageText({ utilization: null, utilizationText: "1% 미만" })).toBe("—");
    expect(modelUsageText({ utilization: 0, utilizationText: "1% 미만" })).toBe("0%");
    expect(modelUsageText({ utilization: 0.01, utilizationText: "1%" })).toBe("1%");
  });

  it("opens compact name/limit controls without marking unchanged values dirty and keeps advanced settings folded", () => {
    const data = modelFixtureRead(), row = data.view.rows[0];
    const form = renderToStaticMarkup(<ModelSettingsForm row={row} device={null} secretBox={true} readOnly={false} compact />);
    expect(form).toContain("화면에서 부를 이름");
    expect(form).toContain(`value="${row.name}"`);
    expect(form).toContain('id="model-connection-details" class="mc-settings-advanced" hidden=""');
    expect(form).not.toContain('data-dirty="true"');
    expect(form).not.toContain(">고치기</button>");
    expect(form).toContain(">변경 확인</button>");
    for (const label of ["추론 토큰 여유", "최대 토큰", "쓸 수 있는 단계", "새 키", "쉬게 하기", "키 바꾸기"]) expect(form).toContain(label);
    const detail = renderToStaticMarkup(<ModelDetail row={row} device={null} secretBox={true} readOnly={false} now={data.view.checkedAt} />);
    const summary = detail.match(/<dl class="mc-dl mc-settings-summary">[^]*?<\/dl>/)![0];
    expect([...summary.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1])).toEqual(["이름", "장비", "연결 방식", "서버 목록", "공유 한도"]);
  });

  it("preserves standalone view-first behavior and read-only/secret protection in compact details", () => {
    const row = modelFixtureRead().view.rows[0];
    const standalone = renderToStaticMarkup(<ModelSettingsForm row={row} device={null} secretBox={true} readOnly={false} />);
    expect(standalone).toContain(">고치기</button>");
    expect(standalone).not.toContain("화면에서 부를 이름");
    const locked = renderToStaticMarkup(<ModelSettingsForm row={row} device={null} secretBox={false} readOnly={true} compact />);
    expect(locked).toContain('disabled="">변경 확인</button>');
    expect(locked).toMatch(/type="text"[^>]*disabled=""/);
    expect(locked).toMatch(/type="password"[^>]*disabled=""/);
    expect(locked).not.toContain(">쉬게 하기</button>");
    const revealed = renderToStaticMarkup(<ModelSettingsForm row={row} device={null} secretBox={true} readOnly={false} compact revealAdvanced />);
    expect(revealed).toContain('aria-expanded="true"');
    expect(revealed).not.toContain('class="mc-settings-advanced" hidden=""');
  });

  it("orders real observations and keeps missing metrics last without changing the source rows", () => {
    const data = modelFixtureRead();
    const rows = [...data.view.rows];
    const missing = { ...rows[0], id: "missing", name: "missing", calls: null, utilization: null };
    expect(modelRowsFor([missing, ...rows], "calls", false, row => row.stageCount).at(-1)?.id).toBe("missing");
    expect(modelRowsFor(rows, "name", false, row => row.stageCount).map(row => row.name))
      .toEqual(rows.map(row => row.name).sort((a, b) => a.localeCompare(b, "ko")));
    expect(modelRowsFor(rows, "usage", true, row => row.stageCount).map(row => row.name)).toEqual(["M1max"]);
    expect(data.view.rows).toEqual(rows);
  });

  it("counts task slots with repeated active models and preserves unknown reads", () => {
    const input = modelFixtureInput();
    const rows = [
      { task: "crawl-tagline", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "crawl-tagline", slot: 1, rank: 2, connectionId: "two", model: "vendor/model", enabled: true, options: {} },
      { task: "crawl-tagline", slot: 1, rank: 3, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "product-translate", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "product-translate", slot: 1, rank: 2, connectionId: "one", model: "model", enabled: false, options: {} },
      { task: "korean-translation-direct", slot: 1, rank: 1, connectionId: "one", model: "model", enabled: true, options: {} },
      { task: "korean-translation-direct", slot: 1, rank: 2, connectionId: "one", model: "model", enabled: true, options: {} },
    ];
    const editor = buildTaskRankEditor(input.connections!, rows, () => "revision");
    expect(modelDuplicateAssignments(editor)).toBe(1);
    expect(modelDuplicateAssignments(null)).toBeNull();
  });

  it("uses unified actual settings for model association counts and detail task links", () => {
    const data = modelFixtureRead();
    const id = "conn-m3-deepseek";
    const html = renderToStaticMarkup(<ModelConsole data={data} selected={id} readOnly={false} duplicateCount={2}
      onTaskOpen={() => {}} onModelScope={() => {}} taskUses={{ [id]: [
        { key: "human-review#1", label: "사람 몫 위임 검수", place: "별도 적용 설정" },
        { key: "split-confirm#1", label: "2차 갈림 재확인", place: "별도 적용 설정" },
      ] }} />);
    expect(html).toContain("같은 모델 반복 2개");
    expect(html).toContain('aria-label="m3-deepseek의 쓰는 작업 보기">2</button>');
    expect(html).toContain("사람 몫 위임 검수");
    expect(html).toContain("별도 적용 설정");
    expect(html).toContain('id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" hidden=""');
    expect(html).not.toContain('id="model-add"');
  });

  it("offers the shared task editor with model constraints and no second inline save flow", () => {
    const input = modelFixtureInput();
    const editor = buildTaskRankEditor(input.connections!, input.ranks!.map(row => ({ ...row, options: {} })), () => "revision");
    const html = renderToStaticMarkup(<ModelAttachForm connectionId="conn-m1max" editor={editor} devices={null} poolHelp={null}
      readOnly={false} onTaskOpen={() => {}} />);
    expect(html).toContain("작업에 붙이기");
    expect(html).toContain('value="product-tagline-ko#1"');
    expect(html).toContain(">자리 고르기 →</button>");
    expect(html).not.toContain("바뀌는 내용 확인");
    expect(html).not.toContain('name="attach-mode"');
    const disabled = renderToStaticMarkup(<ModelAttachForm connectionId="conn-m1max" editor={editor} devices={null} poolHelp={null}
      readOnly={true} onTaskOpen={() => {}} />);
    expect(disabled).toContain('disabled="">자리 고르기 →</button>');
  });

  it("does not label unavailable assignment reads as an unused model or zero repeats", () => {
    const data = modelFixtureRead({ ranks: null, pools: null });
    const html = renderToStaticMarkup(<ModelConsole data={data} selected={null} readOnly={false} />);
    expect(html).toContain("같은 모델 반복 —");
    expect(html).toContain("쓰는 작업 없는 모델 —");
    expect(html).not.toContain("쓰는 작업 없는 모델 9개");
  });

  it("does not infer unused models from an unreadable empty unified association map", () => {
    const data = modelFixtureRead();
    const html = renderToStaticMarkup(<ModelConsole data={data} selected="conn-m1max" readOnly={false} taskUses={{}} taskUsesReadable={false} />);
    expect(html).toContain('disabled="" aria-pressed="false">쓰는 작업 없는 모델 —</button>');
    expect(html).toContain("일부 배정을 읽지 못해 쓰는 작업 전체를 확인할 수 없습니다.");
    expect(html).toContain("쓰는 작업 미확인");
    expect(html).not.toContain("쓰는 단계 없음");
    expect(html).not.toContain("어느 단계에도 붙어 있지 않습니다.");
    expect(html).not.toContain("아직 쓰는 작업이 없습니다.");
    expect(html).not.toContain("쓰는 작업 없는 모델 9개");
    const empty = renderToStaticMarkup(<ModelConsole data={data} selected={null} readOnly={false} taskUses={{}} taskUsesReadable={true} />);
    expect(empty).toContain('aria-pressed="false">쓰는 작업 없는 모델 9개</button>');
  });

  it("keeps fallback links on the unified route when a shared editor callback is absent", () => {
    const data = modelFixtureRead();
    const html = renderToStaticMarkup(<ModelDetail row={data.view.rows[0]} device={null} secretBox={true} readOnly={false} now={data.view.checkedAt}
      uses={[{ key: "assist-review#1", label: "LLM 보강", place: "1순위", href: "/admin/models/tasks#execution-assist-review-1" }]} />);
    expect(html).toContain('href="/admin/models?task=assist-review%231#tasks"');
    expect(html).toContain('href="/admin/models#tasks"');
    expect(html).not.toContain('href="/admin/models/tasks');
    const unavailable = renderToStaticMarkup(<ModelAttachForm connectionId="missing" editor={null} devices={null} poolHelp={null} readOnly={false} />);
    expect(unavailable).toContain('href="/admin/models#tasks"');
    expect(unavailable).not.toContain('href="/admin/models/tasks');
  });

  it("renders the real add form in drawer steps and waits for authoritative row/device reads", () => {
    const props = { recommendations: [], secretBox: true, readOnly: false, taken: [], missing: false, drawer: true,
      onCreated: () => {}, onStep: () => {}, onReadAgain: () => {}, onClose: () => {}, onAttachModel: () => {} };
    const first = renderToStaticMarkup(<ModelAddFlow {...props} step={1} row={null} />);
    expect(first).toContain('class="mc-add-steps" aria-label="모델 추가 단계"');
    expect(first).toContain("OpenAI 호환 API");
    expect(first).toContain('type="password"');
    expect(first).toContain("연결 확인 후 다음 →");
    expect(first).not.toContain('class="cs-step"');
    const waiting = renderToStaticMarkup(<ModelAddFlow {...props} step={2} row={null} />);
    expect(waiting).toContain("저장한 모델을 다시 읽는 중입니다.");
    expect(waiting).not.toContain("추가했습니다");
    const read = modelFixtureRead();
    const row = read.view.rows.find(entry => entry.id === "conn-m3-gpt-oss")!;
    const noDevice = renderToStaticMarkup(<ModelAddFlow {...props} step={2} row={{ ...row, limitSource: "connection" }} />);
    expect(noDevice).toContain('disabled="">다음: 쓸 작업 →</button>');
    expect(noDevice).toContain("저장하면 장비 칸이 생겨 한 번 불러 볼 수 있습니다.");
    const withDevice = renderToStaticMarkup(<ModelAddFlow {...props} step={2} row={row} />);
    expect(withDevice).toContain('class="button small">다음: 쓸 작업 →</button>');
    expect(withDevice).toContain("시험 호출");
    expect(withDevice).toContain("최대 토큰");
    const done = renderToStaticMarkup(<ModelAddFlow {...props} step={3} row={{ ...row, stageCount: 0 }} />);
    expect(done).toContain(`${row.name}을(를) 추가했습니다.`);
    expect(done).toContain("쓸 작업 고르기 →");
    expect(done).not.toContain('action="/admin/models/compare"');
  });
});

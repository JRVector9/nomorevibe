import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { recommendStages } from "@/lib/operations/model-console";
import { SAMPLE_COMPARE_SUPPORTED, type SampleComparison } from "@/lib/operations/model-sample-compare";
import { consoleFixtureInputs } from "./fixtures/console-home";
import { modelFixtureInput, modelFixtureRead } from "./fixtures/model-console";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";

const mocks = vi.hoisted(() => ({ read: vi.fn(), backlog: vi.fn(), records: vi.fn(), editor: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/operations/model-console-read", () => ({ readModelConsole: mocks.read, readModelBacklog: mocks.backlog }));
vi.mock("@/lib/operations/model-sample-compare-repository", () => ({ listModelSampleComparisons: mocks.records }));
vi.mock("@/lib/operations/flow-rank-editor-read", () => ({ readFlowRankEditor: mocks.editor }));
vi.mock("@/lib/operations/pool-help-read", () => ({ readPoolHelpContext: vi.fn(async () => null) }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiConnectionAction: vi.fn(), readAiConnectionModelsAction: vi.fn(), deleteAiConnectionAction: vi.fn(),
  hideAiConnectionModelAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveDeviceRowAction: vi.fn(), saveCapacityDevice: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/compare/actions", () => ({ requestSampleComparisonAction: vi.fn() }));

import { ModelAddSlot, ModelConsoleSlot, SampleCompareSlot } from "@/app/(operator)/admin/models/console/slots";
import { SavePlanDialog } from "@/app/(operator)/admin/models/console/ModelSettingsForm";
import { modelSavePlan, modelSettingsOf } from "@/lib/operations/model-console";
import { modelFixtureDevices } from "./fixtures/model-console";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/\s+/g, " ");
/** 라디오 값 — React 가 checked 를 value 앞에 둘 수 있어 속성 차례를 보지 않는다 */
const radios = (html: string, name: string) => [...html.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map(match => /value="([^"]+)"/.exec(match[0])![1]);
const table = (html: string) => html.match(/<table class="mc-table"[^]*?<\/table>/)![0];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(modelFixtureRead());
  mocks.backlog.mockResolvedValue(buildConsoleTasks(consoleFixtureInputs()));
  mocks.records.mockResolvedValue([]);
  const input = modelFixtureInput();
  mocks.editor.mockResolvedValue(buildTaskRankEditor(input.connections!, input.ranks!.map(row => ({ ...row, options: {} })), () => "revision"));
});

describe("모델 목록(시안 화면 4)", () => {
  it("열 아홉 · 사용률 순 · 모델 한 줄 = 이름 하나 — 서버가 알려 준 모델 이름은 목록에 없다", async () => {
    const html = renderToStaticMarkup(await ModelConsoleSlot({ selected: null, readOnly: false }));
    const list = table(html);
    expect([...list.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map(match => match[1]))
      .toEqual(["이름", "장비", "한도", "지금", "24시간 사용률", "호출", "평균 응답", "쓰는 작업", "상태"]);
    expect([...list.matchAll(/<th scope="row"><a[^>]*>([^<]+)<\/a>/g)].map(match => match[1])).toEqual(["m3-deepseek", "supa-direct", "m3-gpt-oss", "M3 OpenCode",
      "m1-gemma", "gpu3090-qwen", "LG EXAONE", "Claude CLI", "M1max"]);
    for (const served of ["Inferact/Qwen3.8-27B-NVFP4", "gpt-oss-120b", "qwen3.8-flash-next", "k-exaone_v2.5"]) expect(list).not.toContain(served);
    const supa = list.match(/<tr data-model="conn-supa-direct"[^]*?<\/tr>/)![0];
    expect(text(supa)).toContain("supa-direct supa-direct 3 3 / 3 49% 8,404 15.5초 3 미확정 19");
    expect(text(list)).toContain("LG EXAONE Exaone 1 0 / 1 <1% 135 2.2초 1 거절 57");
    expect(list).toContain('href="/admin/models?model=conn-supa-direct#model-detail"');
    expect(html).toContain(">＋ 모델 추가</button>");
    expect(html).not.toContain('id="model-add"');
    expect(html).not.toContain("넣고 응답 확인");
    expect(html).not.toContain('id="model-detail"');
    expect(html).not.toContain('id="admission"');
  });

  it("사용자가 정한 이름·장비가 있으면 그것만 보인다", async () => {
    const read = modelFixtureRead({ connections: modelFixtureRead().view.rows.map(row => row.connection.id === "conn-supa-direct"
      ? { ...row.connection, displayName: "supa", machine: "Supa" } : row.connection) });
    mocks.read.mockResolvedValue(read);
    const list = table(renderToStaticMarkup(await ModelConsoleSlot({ selected: null, readOnly: false })));
    expect(text(list.match(/<tr data-model="conn-supa-direct"[^]*?<\/tr>/)![0])).toMatch(/^ ?supa Supa 3 /);
  });

  it("상세 — 설정 · 쓰는 단계 · 문제 · 조치, 서버 이름은 「연결 확인」에만(같은 root 는 한 묶음)", async () => {
    const html = renderToStaticMarkup(await ModelConsoleSlot({ selected: "conn-supa-direct", readOnly: false }));
    const detail = html.match(/<article id="model-detail"[^]*?<\/article>/)![0];
    expect(table(html)).toContain('data-selected="true" data-model="conn-supa-direct"');
    expect(html).toContain('class="mc-drawer" aria-labelledby="model-detail-title"');
    expect(text(detail)).toContain("24시간 호출 8,404 평균 응답 15.5초 동시 사용 3 / 3");
    expect(text(detail)).toContain("거절 0 보내기 전에 끝남 3 미확정 19");
    expect(text(detail)).toContain("동시 한도 3 · 장비 한도");
    expect(text(detail)).toContain("1차 AI 검수 1순위 배정 보기");
    expect(text(detail)).toContain("미확정 24시간 안에 결과를 모르는 호출이 19건 있습니다.");
    expect(detail).toContain("<code>supa = Inferact/Qwen3.8-27B-NVFP4</code>");
    expect(text(detail)).toMatch(/서버가 알려 준 이름 ?: supa = Inferact\/Qwen3\.8-27B-NVFP4 \(최대 131,072\) · 11-12 07:00 읽음 · 장비 id supa-direct/);
    for (const label of ["변경 확인", "쉬게 하기", "키 바꾸기"]) expect(detail).toContain(`>${label}</button>`);
    expect(detail).toContain('href="/admin/models/compare?task=product-tagline-ko&amp;candidate=conn-supa-direct&amp;model=supa"');
  });

  it("CLI 모델에는 키 바꾸기가 없고, 읽기 전용이면 조치 단추가 없다", async () => {
    const cli = renderToStaticMarkup(await ModelConsoleSlot({ selected: "conn-claude-cli", readOnly: false }));
    expect(cli).not.toContain(">키 바꾸기</button>");
    expect(text(cli)).toContain("방식 CLI · Claude");
    const readOnly = renderToStaticMarkup(await ModelConsoleSlot({ selected: "conn-lg-exaone", readOnly: true }));
    expect(readOnly).not.toContain(">쉬게 하기</button>");
    expect(readOnly).not.toContain(">＋ 모델 추가</button>");
    expect(text(readOnly)).toContain("키 11-11 넣음 · 12-11 만료 · 28일 남음");
  });

  it("접수가 멈춰 있으면 옛 대시보드 주소(#admission)를 받아 접수 바꾸기로 보낸다 · 모르는 모델은 알린다", async () => {
    mocks.read.mockResolvedValue({ ...modelFixtureRead(), admission: { mode: "draining", since: "2026-11-11T23:08:04.000Z" } });
    const html = renderToStaticMarkup(await ModelConsoleSlot({ selected: "nope", readOnly: false }));
    expect(html).toContain('id="admission"');
    expect(text(html)).toContain("모델 접수 중단 · 11-12 08:08부터 — 접수 바꾸기(대시보드)");
    expect(html).toContain('href="/admin/models/dashboard#admission"');
    expect(text(html)).toContain("고른 모델을 찾지 못했습니다");
  });
});

describe("저장 전 확인(다섯 걸음의 4)", () => {
  it("바뀌는 값은 전(지움 줄) → 후, 함께 쓸 곳과 영향을 줄마다 — 「바꾸기」를 눌러야 저장한다", () => {
    const row = modelFixtureRead().view.rows.find(entry => entry.id === "conn-m3-gpt-oss")!;
    const plan = modelSavePlan(row, modelFixtureDevices().find(device => device.deviceId === "m3-mlx")!, { ...modelSettingsOf(row), limit: 3, name: "M3 gpt-oss" });
    const html = renderToStaticMarkup(<SavePlanDialog title="M3 gpt-oss 설정을 바꿉니다" plan={plan} pending={false} disabled={false} />);
    expect(html).toContain("<li><span>이름</span><span><s>m3-gpt-oss</s>M3 gpt-oss</span></li>");
    expect(html).toContain("<li><span>동시 한도</span><span><s>2</s>3</span></li>");
    expect(text(html)).toContain(`함께 씀 장비 ${row.machine}의 이 모델 한도 2 → 3`);
    expect(text(html)).not.toContain("gpt-oss-120b");
    expect(text(html)).toContain("영향 이 모델을 쓰는 단계 6개:");
    expect(html).toContain(">바꾸기</button>");
  });
});

describe("모델 추가 세 걸음(시안 흐름 3)", () => {
  it("① 넣기 — 방식·주소·키", async () => {
    const html = renderToStaticMarkup(await ModelAddSlot({ id: null, step: 1, readOnly: false }));
    // 시안 화면 3 — 세 칸이 나란히(1 넣기 · 2 이름과 한도 · 3 쓸 단계), 지금 칸은 첫 칸
    expect(html.match(/class="cs-k">[^<]+</g)).toEqual(['class="cs-k">1 넣기<', 'class="cs-k">2 이름과 한도<', 'class="cs-k">3 쓸 단계<']);
    expect(html).toMatch(/<li class="cs-step" data-state="now" aria-current="step" aria-label="넣기">/);
    expect(text(html)).toContain("넣고 응답 확인");
  });

  it("② 이름과 한도 — 넣은 것의 확인 줄과 이름·장비·동시 한도·최대 토큰, 시험 호출", async () => {
    const html = renderToStaticMarkup(await ModelAddSlot({ id: "conn-m1max", step: 2, readOnly: false }));
    expect(text(html)).toContain("확인 응답 정상 · 모델 2개 찾음");
    expect(html).toContain('value="M1max"');
    expect(html).toContain('placeholder="m1max"');
    expect(text(html)).toContain("응답 테스트");
    expect(html).toContain('href="/admin/models/new?id=conn-m1max&amp;step=3"');
  });

  it("③ 쓸 단계 — 밀린 단계부터 권하고 표본 비교로 · 「나중에」는 홈", async () => {
    const html = renderToStaticMarkup(await ModelAddSlot({ id: "conn-m1max", step: 3, readOnly: false }));
    expect(radios(html, "task")).toEqual(["product-translate", "reason-translate", "product-search-verify"]);
    expect(text(html)).toContain("96일 밀림 · 비교 지원 안 함");
    expect(html).toContain('action="/admin/models/compare"');
    expect(html).toContain('href="/admin/flow"');
    // 권하기는 홈 「쌓임」과 같은 계산(console-tasks)이다
    expect(recommendStages(buildConsoleTasks(consoleFixtureInputs()), modelFixtureRead().view.rows.find(row => row.id === "conn-m1max")!.connection,
      SAMPLE_COMPARE_SUPPORTED, null)[0].fact).toBe("대기 187,380건 · 하루 1,958건 처리 · 지금 속도로 96일");
  });
});

describe("표본 비교(시안 흐름 2)", () => {
  const done: SampleComparison = { id: 11, task: "product-tagline-ko", status: "done", statusCode: null,
    candidate: { connectionId: "conn-m1max", model: "mlx-community/Qwen3.8-27B-4bit", name: "M1max" },
    current: { connectionId: "conn-m3-gpt-oss", model: "gpt-oss-120b", name: "m3-gpt-oss" }, size: 2, deferrals: 0, requestedBy: "jr",
    requestedAt: "2026-11-12T00:10:00.000Z", startedAt: "2026-11-12T00:11:00.000Z", finishedAt: "2026-11-12T00:20:00.000Z",
    items: [
      { productId: 1, name: "claude-meter", text: "A speedometer for your Claude Code limits, in the macOS menu bar.",
        current: { state: "done", output: "macOS 메뉴 막대에서 Claude Code 한도를 재는 속도계", pass: true },
        candidate: { state: "done", output: "Claude Code 한도를 위한 속도계를 macOS 메뉴 막대에서", pass: true } },
      { productId: 2, name: "statcan-mcp", text: "Statistics Canada MCP Server — Web Data Service Interface for Large Language Models",
        current: { state: "done", output: "대규모 언어 모델용 Statistics Canada MCP Server의 Web Data Service 인터페이스", pass: false, reason: "rejected:not_korean" },
        candidate: { state: "skipped", reason: "already_done" } },
    ] };

  it("원문 · 지금 모델 · 후보 모델을 나란히, 검사 탈락은 까닭과, 끝나면 붙이기·붙이지 않기", async () => {
    mocks.records.mockResolvedValue([done]);
    const html = renderToStaticMarkup(await SampleCompareSlot({ task: "product-tagline-ko", candidate: "conn-m1max", model: null, readOnly: false }));
    expect(text(html)).toContain("지금 모델 m3-gpt-oss");
    // 후보는 사용률 낮은 순 — 1순위(m3-gpt-oss)와 이 작업을 받지 않는 모델(Claude CLI)은 빠진다. OpenCode 는 이 작업을 받는다
    expect(radios(html, "candidate")).toEqual(["conn-m1max", "conn-lg-exaone", "conn-gpu3090-qwen", "conn-m1-gemma", "conn-m3-opencode",
      "conn-supa-direct", "conn-m3-deepseek"]);
    const record = html.match(/<section class="mc-card"[^>]*data-comparison="11"[^]*?<\/section>/)![0];
    expect([...record.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match => match[1])).toEqual(["원문", "m3-gpt-oss", "M1max"]);
    expect(text(record)).toContain("검사 통과 · m3-gpt-oss 1/2");
    expect(text(record)).toContain("검사 통과 · M1max 1/1");
    expect(text(record)).toContain("검사 탈락: 한국어 아님");
    expect(text(record)).toContain("이미 처리됨(표본에서 빠짐)");
    // 붙이기는 그 단계 패널의 모델 구역에서(운영 콘솔 2a — 순위·「동시에」를 그 자리에서)
    expect(record).toContain('href="/admin/flow?stage=tagline-ko#sp-models"');
    expect(text(record)).toContain("이 모델을 붙이기");
  });

  it("지원 안 하는 작업은 까닭을 그대로 보이고 그 단계 패널로 보낸다 · 기록을 못 읽으면 알린다", async () => {
    mocks.records.mockResolvedValue(null);
    const html = renderToStaticMarkup(await SampleCompareSlot({ task: "product-translate", candidate: null, model: null, readOnly: false }));
    expect(text(html)).toContain("지원 안 함 — 공개 번역은");
    expect(html).toContain('href="/admin/flow?stage=product-translate#sp-models"');
    expect(html).not.toContain('name="candidate"');
  });

  it("끝나지 않은 비교가 있으면 새 요청 단추를 막는다", async () => {
    mocks.records.mockResolvedValue([{ ...done, status: "running", items: done.items.map(item => ({ ...item, candidate: null })) }]);
    const html = renderToStaticMarkup(await SampleCompareSlot({ task: "product-tagline-ko", candidate: null, model: null, readOnly: false }));
    expect(html).toMatch(/<button type="submit" class="button small primary" disabled="">표본 비교 시작<\/button>/);
    expect(text(html)).toContain("부르는 중 · 2/4");
  });
});

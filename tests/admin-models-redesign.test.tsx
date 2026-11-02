import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/operation-actions", () => ({ probeAdminModel: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/actions", () => ({ saveReviewModels: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/stage-model-actions", () => ({ saveAdminStageModels: vi.fn() }));
import { LiveModels, StageStatusRibbon, ThroughputMetrics } from "@/app/(operator)/admin/models/LiveModels";
import { ModelSaveBar } from "@/app/(operator)/admin/models/ModelChips";
import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { addressHost, buildModelCards, MODEL_DASHBOARD_STAGES, MODEL_TABLE_COLUMNS, modelContractLinks, modelServer, modelTransportLabel, stageHealth } from "@/lib/operations/admin-models-view";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { redesignObservation, redesignModels, redesignAssignments, redesignMetrics, redesignRequests } from "./fixtures/admin-models-redesign";
const render = () => renderToStaticMarkup(createElement(LiveModels, { observation: redesignObservation(), models: redesignModels, assignments: redesignAssignments }));
const tbodies = (html: string) => html.match(/<tbody id="model-[^"]+"[\s\S]*?<\/tbody>/g) ?? [];
describe("admin models 한 화면 렌더(2026-10-31 승인 시안)", () => {
  // 2026-10-30 결정: 미확인은 점유가 아니므로 "멈춤" 판정은 없다 — 그룹 상한(limit 1)이어도 미확인 1건은 "미확인 1건"으로만 그린다.
  it.each(["정상", "느림", "미확인", "접수 중지"] as const)("장부를 못 읽었을 때의 상태 띠가 %s 판정을 배지로 그린다", expected => {
    const observation = redesignObservation(); const row = { ...redesignMetrics[0], indeterminate: 0, succeeded1h: 1 };
    let requests = [] as typeof redesignRequests;
    if (expected === "느림") { row.waiting = 1; requests = [{ ...redesignRequests[0], state: "waiting" }]; }
    if (expected === "미확인") row.indeterminate = 1;
    if (expected === "접수 중지") observation.mode = "draining";
    observation.rows = [row]; observation.requests = requests;
    expect(stageHealth(observation, [row], requests)).toBe(expected);
    const html = renderToStaticMarkup(createElement(StageStatusRibbon, { observation, cards: buildModelCards(observation, redesignModels) }));
    const first = html.match(/<a .*?<\/a>/)?.[0]; expect(first).toContain(`>${expected}${expected === "미확인" ? " 1건" : ""}</span>`);
  });
  it("지원하는 모든 단계(처리량 접기)·마지막 성공·확인 못함 수를 빠짐없이 표시하고, 갱신 띠는 상단(RefreshBar)으로 옮겼다", () => {
    const html = render(); for (const stage of MODEL_DASHBOARD_STAGES) expect(html).toContain(stage.label);
    expect(html).toContain("확인 못함 1"); expect(html).toContain(">2분 전<"); expect(html).toContain(">마지막 성공</th>");
    expect(html).not.toContain("30초 자동 새로고침"); expect(html).toContain("검토 목록");
  });
  it("모델을 단계 × 모델 표 12열(단계·경로 / 모델 / 장비·출처 / 전송 / 상태 / 점유·한도 / 대기 / 미확인 / 1시간 / 마지막 성공 / 연결 확인 / 동작)로 그린다", () => {
    const html = render();
    expect(html).toContain("<article"); expect(MODEL_TABLE_COLUMNS).toHaveLength(8);
    for (const column of MODEL_TABLE_COLUMNS) expect(html).toContain(`>${column}</th>`);
    expect(html).toContain('<caption class="sr-only">단계별 모델 상태 표');
    expect(html).toContain("models-stage-head");
    // 모델 하나 = tbody 하나(단계 행 묶음) — 경보 칩·옛 링크의 # 앵커가 그 tbody 로 간다
    const rows = tbodies(html); expect(rows).toHaveLength(3);
    const supa = rows.find(row => row.includes("Qwen3.8-27B-NVFP4"))!;
    for (const value of ["1차 검수", "Supa", "출처 등록부", "계약 없음", "확인 못함 1", "연결 확인", "모델 재시작", 'data-state="unknown"', "model-row-unknown"]) expect(supa).toContain(value);
    expect(supa).not.toContain("(abcllm)"); expect(supa).not.toContain("게이트웨이");
    expect(html).toContain("접수 일시중지"); expect(html).not.toContain("표를 좌우로 밀어"); expect(html).not.toContain("min-w-[1360px]");
    // 상태는 색+글자+글리프 — 범례에 여섯 상태가 모두 있다
    for (const label of ["연결됨", "처리 중", "보류", "접수 중지", "연결 안 됨", "확인 못함"]) expect(html).toContain(`</span>${label}</span>`);
  });
  it("등록부에 없는 계약 모델은 계약 주소(host:port)로 장비를 보이고 키는 절대 보이지 않는다", () => {
    const observation = redesignObservation();
    const contractRow = { ...redesignMetrics[0], routeId: "search-verify", provider: "abcllm", model: "nemotron-x", groupId: "oracle-helper", providerBudgetId: "oracle-helper", indeterminate: 0, succeeded1h: 3 };
    observation.rows.push(contractRow);
    const contracts = modelContractLinks([{ routeId: "search-verify", model: "nemotron-x", transport: "direct",
      contract: { endpoint: "http://op:SECRET-PASS@10.9.8.7:8080/v1/chat/completions?api_key=SECRET-QUERY", apiKey: "SECRET-KEY" } }]);
    const html = renderToStaticMarkup(createElement(LiveModels, { observation, models: redesignModels, assignments: redesignAssignments, contracts }));
    const row = tbodies(html).find(row => row.includes("nemotron-x"))!;
    expect(row).toContain("10.9.8.7:8080"); expect(row).toContain("주소로 추정"); expect(row).toContain("엔진 직접(계약)");
    expect(row).not.toContain("장비 미확인"); expect(html).not.toContain("SECRET");
    // 주소도 없으면 정책 route 의 groupId, 그래도 없으면 장비 미확인 + 이름 붙이는 곳 안내
    const noAddress = renderToStaticMarkup(createElement(LiveModels, { observation, models: redesignModels, assignments: redesignAssignments }));
    const groupRow = tbodies(noAddress).find(row => row.includes("nemotron-x"))!;
    expect(groupRow).toContain("oracle-helper"); expect(groupRow).toContain("그룹 ID");
    const bare = buildModelCards(redesignObservation(), redesignModels, [{ id: "audit-review", label: "감사", models: [{ provider: "abcllm", model: "ghost-model" }] }]);
    expect(bare.find(card => card.name === "ghost-model")).toMatchObject({ equipment: "장비 미확인", equipmentSource: null });
    const bareHtml = renderToStaticMarkup(createElement(LiveModels, { observation: redesignObservation(), models: redesignModels, assignments: [{ id: "audit-review", label: "감사", models: [{ provider: "abcllm", model: "ghost-model" }] }] }));
    expect(bareHtml).toContain("장비 미확인"); expect(bareHtml).toContain('href="/admin/models/contracts"'); expect(bareHtml).toContain("등록부에 장비 이름 붙이기");
  });
  it("다른 단계의 미확인이 같은 그룹에 있으면 해당 단계에도 미확인과 건수를 표시한다(슬롯은 막지 않는다)", () => {
    // 2026-10-30 결정: 같은 장비(m1)의 미확인은 사람 검토 대상으로 보이기만 하고, 그 단계를 멈춤으로 만들지 않는다.
    const observation = redesignObservation();
    const row = { ...redesignMetrics[2], routeId: "reason-translate", indeterminate: 0, waiting: 0 };
    observation.rows.push(row);
    expect(stageHealth(observation, [row], [])).toBe("미확인");
    const html = renderToStaticMarkup(createElement(StageStatusRibbon, { observation, cards: buildModelCards(observation, redesignModels) }));
    const cell = html.match(/<a [\s\S]*?<\/a>/g)?.find(cell => cell.includes("심사 사유 번역"));
    expect(cell).toContain(">미확인 1건</span>"); expect(cell).not.toContain("멈춤");
    expect(cell).toContain("마지막 성공 기록 없음");
  });
  it("미설정 화면 판별을 가짜 모델 카드로 만들지 않는다", () => {
    const cards = buildModelCards(redesignObservation(), redesignModels, [{ id: "screen-review", label: "화면 판별", models: [{ provider: "local-direct", model: "미설정" }] }]);
    expect(cards.some(card => card.name === "미설정")).toBe(false);
  });
  it("건강한 병렬 모델이 있어도 그룹의 미확인은 해당 단계에 미확인으로만 표시한다", () => {
    const observation = redesignObservation();
    expect(stageHealth(observation, observation.rows.slice(0, 2), observation.requests.slice(0, 1))).toBe("미확인");
  });
  it("미확인 행은 요청 시작(KST)·경과·슬롯 점유 없음과 M1 sudo/Supa root 비활성 사유를 보이고, 미확인 수는 검토 목록의 그 요청으로 간다", () => {
    // 2026-10-30 결정: 미확인 요청은 단계를 막지 않으므로 "막고 있는 단계" 대신 "슬롯 점유 없음"을 안내한다.
    const html = render();
    for (const value of ["요청 시작 15:40:00 KST", "20분째", "미확인은 슬롯 점유 없음 · 사람 검토 뒤 닫기", "확인 못함 2건 · 사람 검토", "M1 sudo 필요", "Supa root 필요", `href="#rv-${redesignRequests[0].requestId}"`]) expect(html).toContain(value);
    expect(html).not.toContain("막고 있는 단계"); expect(html).not.toContain("멈춤"); expect(html).not.toContain("모델 슬롯 가득");
    expect(html.match(/<button[^>]*disabled=""[^>]*>종료\(정식 해제\)<\/button>/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*disabled=""[^>]*>모델 재시작<\/button>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("접수 일시중지/재개는 모든 공통 모델에 적용됩니다");
  });
  it("내부 ID 낱말은 기본 접힌 「내부 ID」 안에만 있고 모델은 장비·이름으로 표시한다", () => {
    const html = render(); const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
    for (const value of ["routeId", "groupId", "providerBudgetId", "requestId"]) { expect(html).toContain(value); expect(visible).not.toContain(value); }
    expect(html).not.toMatch(/<details[^>]*\sopen/); expect(visible).toContain("[Supa]");
  });
  it("종료 표본이 없으면 기록 없음이며 시간당 0건·실패율 0%로 꾸미지 않는다", () => {
    const html = renderToStaticMarkup(createElement(ThroughputMetrics, {}));
    expect(html).toContain("기록 없음"); expect(html).not.toContain("0.0%"); expect(html).not.toContain("0초");
  });
  it.each([{ changes: [], pending: false, disabled: true }, { changes: ["1차 검수"], pending: false, disabled: false }, { changes: ["1차 검수"], pending: true, disabled: true }])("저장 활성 조건 $changes / pending $pending", ({ changes, pending, disabled }) => {
    const html = renderToStaticMarkup(createElement(ModelSaveBar, { changes, pending }));
    expect(/<button[^>]*disabled=""/.test(html)).toBe(disabled); if (changes.length) expect(html).toContain("1차 검수");
  });
  it("옛 1차 설정(Supa 주 + 추가 MLX)이 있어도 1차·2차 칸은 그리지 않고 「작업 ↔ 모델」 안내만 둔다(PR C1) — 단계 풀 저장 바는 그대로", () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[supa] Qwen3.8-27B-NVFP4" }, firstReviewAdditional: [{ provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" }] };
    const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings, version: "fixture-cas", models: redesignModels }));
    expect(html).not.toContain('name="primaryModel0"');
    expect(html).not.toContain('name="firstAdditionalModel0"');
    expect(html).toContain('data-task-ranks-pointer="true"'); expect(html).toContain('href="/admin/models/tasks#tasks"');
    expect(html).toContain('name="stageModelPools"');
    expect(html).toContain("설정 바꾸기"); expect(html).toContain("저장된 설정과 같습니다");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>모델 설정 저장<\/button>/);
  });
});

describe("모델 카드 서버 이름 — 장비 미확인 없이(2026-10-31)", () => {
  it("주소·장비·같은 이름 항목·장비 그룹·대괄호 라벨 순으로 서버 이름을 찾는다", async () => {
    const { modelServerName } = await import("@/lib/operations/admin-models-view");
    const models = [
      { key: "gpu3090:review", equipment: "gpu3090", provider: "local-direct", model: "qwen3.8-flash-next", baseUrl: "http://100.77.43.63:8090/v1" },
      { key: "mlx:text", equipment: "mlx", provider: "abcllm", model: "gpt-oss-120b", baseUrl: "http://100.92.77.66:8014/v1" },
      { key: "m1:translation", equipment: "m1", provider: "abcllm", model: "gemma", baseUrl: "https://m1-studio.tail02799e.ts.net/v1" },
    ] as never[];
    // 1차 검수 abcllm 계약: 등록부엔 local-direct 항목뿐 — 같은 모델 이름의 유일한 항목 주소로 gpu3090
    expect(modelServerName({ provider: "abcllm", model: "qwen3.8-flash-next" }, undefined, models, ["gpu3090-qwen"])).toBe("gpu3090");
    expect(modelServerName({ provider: "abcllm", model: "gpt-oss-120b" }, models[1], models, [])).toBe("M3 Ultra");
    expect(modelServerName({ provider: "abcllm", model: "gemma" }, models[2], models, [])).toBe("M1 Studio");
    // 등록부에서 사라진 옛 이름은 그 카드가 쓴 장비 그룹으로
    expect(modelServerName({ provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4" }, undefined, models, ["supa", "supa-direct"])).toBe("Supa");
    expect(modelServerName({ provider: "abcllm", model: "[MLX] gpt-oss-120b" }, undefined, models, [])).toBe("M3 Ultra");
    expect(modelServerName({ provider: "abcllm", model: "unknown-model" }, undefined, models, [])).toBe("장비 미확인");
  });
  it("이름 표에 없어도 계약 주소 host:port → 정책 groupId → 그래도 없으면 장비 미확인 순으로 보이고 출처를 함께 준다", () => {
    const models = [{ key: "gpu3090:review", equipment: "gpu3090", provider: "local-direct", model: "qwen3.8-flash-next", baseUrl: "http://100.77.43.63:8090/v1" }] as never[];
    const direct = (host: string) => [{ routeId: "search-verify", model: "x", host, transport: "direct" as const }];
    // 계약 주소의 호스트가 이름 표에 있으면 서버 이름(출처 주소)
    expect(modelServer({ provider: "abcllm", model: "x" }, undefined, models, [], direct("100.78.219.124:8000"))).toEqual({ name: "Supa", source: "주소" });
    // 이름 표에 없는 엔진 직접 주소는 host:port 원문(키·경로 없음)
    expect(modelServer({ provider: "abcllm", model: "x" }, undefined, models, ["oracle-helper"], direct("10.9.8.7:8080"))).toEqual({ name: "10.9.8.7:8080", source: "주소로 추정" });
    // 게이트웨이 주소는 엔진이 아니므로 추정에 쓰지 않는다 → groupId 원문
    expect(modelServer({ provider: "abcllm", model: "x" }, undefined, models, ["oracle-helper"], [{ routeId: "search-verify", model: "x", host: "abcllm-api.brut.bot", transport: "gateway" }]))
      .toEqual({ name: "oracle-helper", source: "그룹 ID" });
    expect(modelServer({ provider: "abcllm", model: "x" }, undefined, models, ["b-group", "a-group"], [])).toEqual({ name: "a-group · b-group", source: "그룹 ID" });
    expect(modelServer({ provider: "abcllm", model: "x" }, undefined, models, [], [])).toEqual({ name: "장비 미확인", source: null });
    // 등록부 항목의 출처: 주소가 표에 있으면 주소, 아니면 등록부(장비 값); 같은 이름 항목은 그렇게 표시
    expect(modelServer({ provider: "local-direct", model: "qwen3.8-flash-next" }, models[0], models, [])).toEqual({ name: "gpu3090", source: "주소" });
    expect(modelServer({ provider: "abcllm", model: "qwen3.8-flash-next" }, undefined, models, [])).toEqual({ name: "gpu3090", source: "같은 이름 항목" });
    expect(modelServer({ provider: "abcllm", model: "gpt-oss-120b" }, { key: "mlx:text", equipment: "mlx", provider: "abcllm", model: "gpt-oss-120b", baseUrl: "https://abcllm-api.brut.bot/v1" } as never, models, []))
      .toEqual({ name: "M3 Ultra", source: "등록부" });
    expect(modelServer({ provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4" }, undefined, models, ["supa", "supa-direct"])).toEqual({ name: "Supa", source: "장비 그룹" });
    expect(modelServer({ provider: "abcllm", model: "[supa] Qwen" }, undefined, models, [])).toEqual({ name: "Supa", source: "이름표" });
  });
  it("운영 주소 표: Tailscale IP·MagicDNS 호스트명·localhost(M3 자체)를 서버 이름으로 푼다", () => {
    const at = (baseUrl: string) => modelServer({ provider: "local-direct", model: "m" }, { key: "x:m", equipment: "x", provider: "local-direct", model: "m", baseUrl } as never, [], []);
    expect(at("http://100.92.77.66:8010/v1")).toEqual({ name: "M3 Ultra", source: "주소" });
    expect(at("http://100.92.77.66:8014/v1").name).toBe("M3 Ultra");
    expect(at("http://100.78.219.124:8000/v1").name).toBe("Supa");
    expect(at("http://100.77.43.63:8090/v1").name).toBe("gpu3090");
    expect(at("https://m1-studio.tail02799e.ts.net/v1").name).toBe("M1 Studio");
    expect(at("https://m3ultra.tail02799e.ts.net:8014/v1").name).toBe("M3 Ultra");
    expect(at("http://9mini.tail02799e.ts.net:8010/v1").name).toBe("mini");
    expect(at("http://localhost:8010/v1").name).toBe("M3 Ultra");
    expect(at("http://127.0.0.1:8014/v1").name).toBe("M3 Ultra");
    expect(at("http://[::1]:8014/v1").name).toBe("M3 Ultra");
    // 표에 없는 주소는 등록부 장비 값으로 떨어진다(원문 x)
    expect(at("http://10.0.0.5:8000/v1")).toEqual({ name: "x", source: "등록부" });
  });
  it("주소는 host:port 만 남기고 사용자 정보·경로·query 를 버린다 — 계약 행에서 endpoint 만 읽는다", () => {
    expect(addressHost("http://op:SECRET@100.77.43.63:8090/v1/chat/completions?api_key=SECRET")).toBe("100.77.43.63:8090");
    expect(addressHost("https://m1-studio.tail02799e.ts.net/v1")).toBe("m1-studio.tail02799e.ts.net");
    expect(addressHost("not a url")).toBeNull(); expect(addressHost(null)).toBeNull(); expect(addressHost("ftp://x/y")).toBeNull();
    const links = modelContractLinks([
      { routeId: "search-verify", model: "a", transport: "direct", contract: { endpoint: "http://10.9.8.7:8080/v1/chat/completions", apiKey: "SECRET", tokenizerEndpoint: "http://10.9.8.7:8080/tokenize" } },
      { routeId: "crawl-agent-review", model: "b", transport: "gateway", contract: { endpoint: 42 } },
      { routeId: "crawl-agent-review", model: "c", transport: "gateway", contract: null },
    ]);
    expect(links).toEqual([{ routeId: "search-verify", model: "a", host: "10.9.8.7:8080", transport: "direct" },
      { routeId: "crawl-agent-review", model: "b", host: null, transport: "gateway" }, { routeId: "crawl-agent-review", model: "c", host: null, transport: "gateway" }]);
    expect(JSON.stringify(links)).not.toContain("SECRET");
  });
  it("전송 방식: 열리는 직접 연결만 「직접」, CLI 는 「CLI」, abcllm 은 직접 연결 계약이 없으면 열리지 않는다", () => {
    expect(modelTransportLabel("abcllm", [{ routeId: "r", model: "m", host: null, transport: "direct" }])).toBe("엔진 직접(계약)");
    expect(modelTransportLabel("abcllm", [{ routeId: "r", model: "m", host: null, transport: "gateway" }])).toBe("직접 연결 계약 필요");
    expect(modelTransportLabel("abcllm", [{ routeId: "r", model: "m", host: null, transport: "gateway" }, { routeId: "s", model: "m", host: null, transport: "direct" }])).toBe("엔진 직접(계약)");
    expect(modelTransportLabel("local-direct", [])).toBe("엔진 직접");
    expect(modelTransportLabel("local-direct", [{ routeId: "r", model: "m", host: null, transport: "gateway" }])).toBe("엔진 직접(계약)");
    expect(modelTransportLabel("claude-cli", [])).toBe("CLI"); expect(modelTransportLabel("abcllm", [])).toBe("계약 없음");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { GPU, LLM_NOW, llmConnections, llmConveyor, llmObservation, llmRankRows, llmRuntime, M1, OPENCODE, SUPA as SUPA_ID } from "./fixtures/llm-ops";

const mocks = vi.hoisted(() => ({
  observation: vi.fn(), conveyor: vi.fn(), jobs: vi.fn(), connections: vi.fn(), rows: vi.fn(), runtime: vi.fn(), executions: vi.fn(), opsStates: vi.fn(),
  classifier: vi.fn(), reviewQueue: vi.fn(), auditRows: vi.fn(), redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "jr" }) }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/operations/conveyor", () => ({ readConveyor: mocks.conveyor }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: mocks.jobs }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiConnections: mocks.connections, listAiTaskRows: mocks.rows, readAiTaskRuntime: mocks.runtime }));
vi.mock("@/lib/operations/admin-ai-task-execution", () => ({ readAiTaskExecutionAdminViews: mocks.executions }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ readModelOpsStates: mocks.opsStates }));
vi.mock("@/lib/security/secret-box", () => ({ secretBoxReady: () => true }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: async () => undefined, servingContractSnapshot: () => ({ rows: [
  { routeId: "cli:grok-cli:grok-session-check", model: "grok-4.7", contract: { cliVersion: "0.9.1", apiKey: "SECRET-CONTRACT" }, auth: "stored", apiKey: "SECRET-KEY", transport: "direct" },
  { routeId: "second-review", model: "supa", contract: {}, auth: "none", apiKey: null, transport: "direct" }] }) }));
// 변경 기록(operations_audit)은 db.select().from().where().orderBy().limit() 로 읽는다
const auditChain = { from: () => auditChain, where: () => auditChain, orderBy: () => auditChain, limit: (n: number) => mocks.auditRows(n) };
vi.mock("@/lib/db", () => ({ db: { execute: mocks.classifier, select: () => auditChain }, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/operations/model-capacity-unknowns", async original => ({ ...await original<object>(), readModelCapacityReviewQueue: mocks.reviewQueue }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn(), cancelAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiConnectionAction: vi.fn(), readAiConnectionModelsAction: vi.fn(), deleteAiConnectionAction: vi.fn(), hideAiConnectionModelAction: vi.fn(), clearUnreadAiTaskRanksAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/devices/actions", () => ({ saveCapacityDevice: vi.fn() }));

import { LlmOpsSlot, ModelsDashboardSlot, ModelsHistorySlot } from "@/app/(operator)/admin/models/llm-ops-slots";
import { saveConnectionWithLimit, type ConnectionLimitField } from "@/app/(operator)/admin/models/tasks/ConnectionForm";

const far = new Date("2100-01-01T00:00:00.000Z");
afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  vi.clearAllMocks();
  // 실행 쪽 순위 사정은 30분 안의 것만 까닭으로 쓴다 — 자료의 관측 시각에 시계를 맞춘다
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LLM_NOW));
  mocks.observation.mockResolvedValue(llmObservation());
  mocks.conveyor.mockResolvedValue(llmConveyor());
  mocks.jobs.mockResolvedValue([{ name: "product-search-verify", notBefore: far }, { name: "product-intro-check", notBefore: far }, { name: "crawl-agent-review", notBefore: null }]);
  mocks.connections.mockResolvedValue(llmConnections);
  mocks.rows.mockResolvedValue(llmRankRows);
  mocks.runtime.mockResolvedValue(llmRuntime);
  mocks.executions.mockResolvedValue([]);
  mocks.opsStates.mockResolvedValue([]);
  mocks.classifier.mockResolvedValue([{ observedAt: new Date(Date.now() - 20_000).toISOString(), value: { classifyReady: true,
    config: { primary: { model: "gpt-5.6-terra" } }, modelOptions: [{ model: "gpt-5.6-terra", provider: "codex-cli" }],
    classificationContracts: [{ provider: "codex-cli", cliVersion: "codex-cli 0.98.0" }] } }]);
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("LLM 운영 — 같은 모델의 별칭은 한 줄(2026-11-08)", () => {
  it("Supa 의 supa·Inferact 두 이름과 M1 Gemma 의 옛·새 이름을 한 줄로 그리고 칩을 모은다", async () => {
    const QWEN = "Inferact/Qwen3.8-27B-NVFP4", GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit";
    mocks.connections.mockResolvedValue(llmConnections.map(row => row.id === SUPA_ID ? { ...row, models: [{ id: "supa", maxModelLen: 131072 }, { id: QWEN, maxModelLen: 131072 }] }
      : row.id === M1 ? { ...row, label: "m1-gemma", baseUrl: "https://m1-studio.tail02799e.ts.net/v1", host: "m1-studio.tail02799e.ts.net",
        models: [{ id: "m1-gemma", maxModelLen: null }], modelsError: null, modelsReadAt: LLM_NOW } : row));
    mocks.rows.mockResolvedValue([...llmRankRows, { task: "product-translate", slot: 1, rank: 1, connectionId: M1, model: GEMMA, options: {}, enabled: true }]);
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: null, adding: false }));
    const article = (id: string) => html.match(new RegExp(`<article id="conn-${id}"[^]*?</article>`))![0];
    const lines = (id: string) => [...article(id).matchAll(/<li [^>]*data-model-line="([^"]*)"/g)].map(match => match[1]);
    const supa = article(SUPA_ID);
    expect(lines(SUPA_ID)).toEqual([`supa ${QWEN}`]);
    expect(supa).toContain("이 서버의 모델 · 1개");
    expect(supa).not.toContain("배정 없음");
    expect(text(supa)).toContain(`이름 supa · ${QWEN}`);
    // 순위는 옛 이름(GEMMA)으로 저장돼 있고 서버 목록은 새 이름(m1-gemma) — 한 줄(Gemma 4 26B)에 번역 칩이 붙는다
    expect(lines(M1)).toEqual([`m1-gemma ${GEMMA}`]);
    expect(text(article(M1))).toContain("Gemma 4 26B");
    expect(article(M1)).toContain("이 서버의 모델 · 1개");
    expect(article(M1)).not.toContain("배정 없음");
  });
});

describe("LLM 운영 — 안 쓰는 모델 「삭제」(2026-11-08)", () => {
  it("배정 없는 모델 줄에만 「삭제」, 숨긴 모델은 접힌 목록에서 되돌리기 — 읽기 전용이면 단추가 없다", async () => {
    mocks.connections.mockResolvedValue(llmConnections.map(row => row.id === OPENCODE ? { ...row, hiddenModels: ["opencode/old-free"] } : row));
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: null, adding: false }));
    const opencode = html.match(new RegExp(`<article id="conn-${OPENCODE}"[^]*?</article>`))![0];
    const line = (model: string) => opencode.match(new RegExp(`<li [^>]*data-model-line="${model.replaceAll("/", "\\/").replaceAll(".", "\\.")}"[^]*?</li>`))![0];
    // 1차 1순위가 쓰는 모델에는 칩만, 안 쓰는 모델에는 「배정 없음」과 「삭제」
    expect(line("deepseek/deepseek-v4.1-flash")).not.toContain("llm-model-hide");
    const unused = line("deepseek/deepseek-v4.1-pro");
    expect(text(unused)).toContain("배정 없음");
    expect(unused).toContain('name="model" value="deepseek/deepseek-v4.1-pro"');
    expect(unused).toContain('name="hidden" value="1"');
    expect(unused).toContain('aria-label="deepseek/deepseek-v4.1-pro 목록에서 삭제"');
    expect(text(opencode)).toContain("숨긴 모델 1개");
    expect(opencode).toContain('aria-label="opencode/old-free 목록에 되돌리기"');
    const readOnly = renderToStaticMarkup(await LlmOpsSlot({ readOnly: true, editId: null, adding: false }));
    expect(readOnly).not.toContain("llm-model-hide");
  });
});

describe("대시보드(/admin/models) 그리기", () => {
  it("판단 띠·접수 한 곳·KPI 4·먼저 할 일 3·장비 점유 막대·단계 띠를 실제 읽기에서 그린다", async () => {
    const html = renderToStaticMarkup(await ModelsDashboardSlot({ readOnly: false }));
    expect(mocks.observation).toHaveBeenCalledWith({ throughput: false });
    expect(html).toContain('class="llm-banner" data-level="warn"');
    expect(html).toContain("결과 미확정 1건이 재실행을 기다립니다.");
    // 접수 버튼은 한 곳 — 기존 운영 실행기 접수(사유 확인 대화상자)를 그대로 쓴다
    expect(html.match(/접수 중지<\/button>/g)).toHaveLength(1);
    expect(html).toContain('id="admission"');
    expect(html).toMatch(/data-kpi="running"[^]*?4 \/ 17/);
    expect(html).toMatch(/data-kpi="retry"[^]*?>1<\/div>/);
    expect(html.match(/class="llm-todo"/g)).toHaveLength(3);
    // 미확정은 기록 › 재실행 대기로 가고, 지원 단계면 할 일에서 바로 다시 대기열에 넣는다(PR 3)
    expect(html).toContain('href="/admin/models/history#retry"');
    expect(html).toMatch(/data-todo="indeterminate"[^]*?>[^<]+ 다시 대기열<\/button>[^]*?재실행 패널 →/);
    expect(html).toContain(`href="/admin/models/llm?edit=${GPU}&amp;fix=limit#conn-${GPU}-limit"`);
    expect(html).toContain('aria-label="gpu3090-qwen 점유 2 / 5"');
    expect(html.match(/class="llm-stage"/g)).toHaveLength(7);
    expect(text(html)).toContain("일부 중지: 검색 키워드 검수");
    // 상태는 색만으로 가르지 않는다 — 모양과 글자가 함께
    expect(html).toContain('<span class="llm-level-shape" aria-hidden="true">▲</span>주의');
    for (const label of ["정상", "느림·주의", "멈춤·실패", "의도적 중지·쉼", "확인 불가"]) expect(html).toContain(`</span>${label}</span>`);
  });
  it("읽지 못하면 숫자 자리에 0 대신 「확인 불가」, 접수 버튼은 잠긴다", async () => {
    mocks.observation.mockResolvedValue(unavailableAdminModels());
    mocks.conveyor.mockRejectedValue(new Error("down"));
    mocks.jobs.mockRejectedValue(new Error("down"));
    mocks.connections.mockRejectedValue(new Error("down"));
    const html = renderToStaticMarkup(await ModelsDashboardSlot({ readOnly: false }));
    expect(html.match(/class="llm-kpi-value llm-num">확인 불가</g)).toHaveLength(4);
    expect(html).not.toMatch(/class="llm-kpi-value llm-num">0</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>DRAIN 으로 · 접수 중지<\/button>/);
    expect(html).toContain("장부를 읽지 못해 할 일을 정하지 못했습니다");
  });
});

describe("LLM 운영(/admin/models/llm) 그리기", () => {
  it("연결·CLI 도구 한 줄씩 — 모델·점유/한도(불일치 표시)·배정 칩(순위)·상태와 까닭·재실행 대기", async () => {
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: null, adding: false }));
    expect(text(html)).toContain("연결 6 CLI 도구 2");
    const gpu = html.match(new RegExp(`<article id="conn-${GPU}"[^]*?</article>`))![0];
    expect(gpu).toContain('<span class="llm-cap" title="점유(예약+실행 중) / 장비 행 한도">2 / 5</span>');
    expect(text(html)).toContain("LLM(연결) 모델 점유 / 한도 배정된 작업 상태 재실행");
    expect(html).not.toContain("한도 · 점유");
    expect(text(gpu)).toContain("점유 / 한도 2 / 5 ▲ 연결에 남은 옛 값 4 · 실제 적용 5 — 맞추기 →");
    expect(gpu).toContain('<span class="llm-chip-rank">2</span>1차 AI 검수');
    // 연결 표 — 머리 줄이 행과 같은 목록 테두리 안에 있고, 배정된 작업은 칸(llm-task) 단위 격자다
    expect(html).toMatch(/<section class="llm-conn-list"[^>]*><div class="llm-conn-head llm-conn-cols"/);
    expect(gpu).toMatch(/<span class="llm-chips">(<span class="llm-task"><a [^>]*class="llm-chip"[^]*?<\/a><\/span>)+<\/span>/);
    expect(text(gpu)).toContain("미확정 있음 재실행 대기 1건");
    expect(gpu).toContain('href="/admin/models/history#retry">대기 1 →');
    const opencode = html.match(new RegExp(`<article id="conn-${OPENCODE}"[^]*?</article>`))![0];
    expect(text(opencode)).toContain("시간 초과 1회(1차 AI 검수)");
    expect(text(html.match(new RegExp(`<article id="conn-${M1}"[^]*?</article>`))![0])).toContain("목록 못 읽음 서버 응답 없음");
    // Codex·Grok 은 ai_connections 행이 없어도 CLI 도구 행으로 보인다
    const codex = html.match(/<article id="cli-codex-cli"[^]*?<\/article>/)![0];
    expect(codex).toContain('data-source="cli-tool"');
    expect(text(codex)).toContain("Codex CLI");
    expect(text(codex)).toContain("codex-cli 0.98.0(분류 에이전트 관측)");
    expect(codex).toContain('href="/admin/status?tab=ai"');
    expect(text(html.match(/<article id="cli-grok-cli"[^]*?<\/article>/)![0])).toContain("0.9.1(계약)");
    // 키·계약 비밀은 화면에 오지 않는다
    expect(html).not.toContain("SECRET");
  });
  it("행을 펼치면 기존 연결 폼 + 「동시 실행 한도」 한 칸(장비 행 값)과 「저장하고 모델 읽기」, 모델 목록과 그 모델의 작업 칩", async () => {
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: GPU, adding: false }));
    const gpu = html.match(new RegExp(`<article id="conn-${GPU}"[^]*?</article>`))![0];
    expect(gpu).toContain('<details class="llm-conn-edit" open="">');
    expect(gpu).toContain(`name="id" value="${GPU}"`);
    expect(gpu).toContain("동시 실행 한도(장비 행 · 실제 적용 값)");
    expect(gpu).toMatch(/name="capacitySlots"[^>]*value="5"/);
    expect(gpu).not.toContain("칸 수(동시에 처리할 수)");
    expect(gpu).toContain(">저장하고 모델 읽기</button>");
    expect(gpu).toContain("이 서버의 모델 · 1개");
    // 모델 목록도 표처럼 — 모델 이름 옆 작업 격자, 칸 하나에 순위·이름(2026-11-08)
    expect(gpu).toMatch(/<span class="llm-model-name"><code>qwen3.8-flash-next<\/code><\/span><span class="llm-chips"><span class="llm-task"><a [^>]*class="llm-chip"/);
    // 닫힌 다른 행, 「+ 연결 추가」는 닫혀 있다
    expect(html).toContain('<details class="llm-add" id="connection-new">');
    const added = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: null, adding: true }));
    expect(added).toContain('<details class="llm-add" id="connection-new" open="">');
    expect(added).toContain(">만들고 모델 읽기</button>");
  });
  it("문제 표시는 누르면 고칠 곳으로 — 한도 불일치는 그 연결 폼의 한도 칸, 까닭은 기록·연결 폼, 잡이 멈춘 칩 옆은 잡 상태", async () => {
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: null, adding: false }));
    const article = (id: string) => html.match(new RegExp(`<article id="${id}"[^]*?</article>`))![0];
    const anchors = (part: string) => [...part.matchAll(/<a ([^>]*)>([^]*?)<\/a>/g)].map(([, attrs, inner]) => ({
      href: (/href="([^"]*)"/.exec(attrs)?.[1] ?? "").replaceAll("&amp;", "&"), className: /class="([^"]*)"/.exec(attrs)?.[1] ?? "", text: text(inner).trim() }));
    const gpu = anchors(article(`conn-${GPU}`));
    expect(gpu).toContainEqual({ className: "llm-fix llm-flag", href: `/admin/models/llm?edit=${GPU}&fix=limit#conn-${GPU}-limit`,
      text: "▲ 연결에 남은 옛 값 4 · 실제 적용 5 — 맞추기 →" });
    expect(gpu).toContainEqual({ className: "llm-fix llm-reason", href: "/admin/models/history#retry", text: "재실행 대기 1건 — 재실행 보기 →" });
    expect(anchors(article(`conn-${OPENCODE}`)).filter(link => link.className === "llm-fix llm-reason").map(link => [link.href, link.text])).toEqual([
      ["/admin/models/history#failures", "1시간 정산 86 · 실패 2 — 실패 보기 →"], ["/admin/models/history#failures", "시간 초과 1회(1차 AI 검수) — 실패 보기 →"]]);
    expect(anchors(article(`conn-${M1}`))).toContainEqual({ className: "llm-fix llm-reason", href: `/admin/models/llm?edit=${M1}&fix=address#conn-${M1}-address`,
      text: "서버 응답 없음 — 다시 읽기 →" });
    // 잡이 멈춘 작업 칩: 칩은 작업 배정, 옆 링크는 그 잡의 상태 창(키보드로 닿는 a, 낭독기용 이름)
    const supa = article("conn-33333333-3333-4333-8333-333333333333");
    expect(anchors(supa)).toContainEqual({ className: "llm-fix llm-fix-chip", href: "/admin/status?tab=jobs&job=product-search-verify", text: "‖ 잡 보기 →" });
    expect(supa).toContain('aria-label="검색 키워드 검수 잡 일시중지 — 잡 보기"');
    // 고칠 곳이 없는 정상 까닭은 링크가 아니다
    expect(article("conn-22222222-2222-4222-8222-222222222222")).toContain('<span class="llm-reason">1시간 정산 100</span>');
    expect(text(html)).toContain("파란 「— … →」가 붙은 표시는 누르면 고치는 곳으로 갑니다.");
  });
  it("?edit=<연결>&fix=limit 로 열면 한도 칸이 눈에 띄고(장비 행 값 5로 채움) 「저장하면 연결 값도 5(으)로 맞춰집니다」 — 다른 칸·다른 행은 그대로", async () => {
    const html = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: GPU, fix: "limit", adding: false }));
    const gpu = html.match(new RegExp(`<article id="conn-${GPU}"[^]*?</article>`))![0];
    expect(gpu).toContain('<details class="llm-conn-edit" open="">');
    expect(gpu).toContain(`<label class="grid gap-1" id="conn-${GPU}-limit" data-fix-field="limit" data-fix="true">동시 실행 한도(장비 행 · 실제 적용 값)`);
    expect(gpu).toMatch(/name="capacitySlots"[^>]*value="5"/);
    expect(gpu).toContain('data-limit-hint="true">저장하면 연결 값도 5(으)로 맞춰집니다(연결에 남은 옛 값 4).</span>');
    expect(gpu).toContain(`<label class="grid gap-1" id="conn-${GPU}-key" data-fix-field="key">API 키`);
    // 닫힌 행은 ?fix 를 받지 않는다
    expect(html).not.toMatch(new RegExp(`id="conn-${M1}-[a-z]+" data-fix-field="[a-z]+" data-fix="true"`));
    // 주소 칸으로 오면 그 칸과 짧은 안내
    const address = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: M1, fix: "address", adding: false }));
    const m1 = address.match(new RegExp(`<article id="conn-${M1}"[^]*?</article>`))![0];
    expect(m1).toContain(`id="conn-${M1}-address" data-fix-field="address" data-fix="true">주소`);
    expect(text(m1)).toContain("주소·키를 확인하고 「저장하고 모델 읽기」를 누르세요.");
    // 한도가 같은 연결(m3-mlx)에는 맞추기 안내가 없다
    const mlx = renderToStaticMarkup(await LlmOpsSlot({ readOnly: false, editId: "22222222-2222-4222-8222-222222222222", fix: "limit", adding: false }));
    expect(mlx.match(/<article id="conn-22222222-2222-4222-8222-222222222222"[^]*?<\/article>/)![0]).not.toContain("data-limit-hint");
  });
});

describe("기록(/admin/models/history) 그리기", () => {
  const item = { requestId: "7e2c1a90-0000-4000-8000-000000000001", routeId: "crawl-agent-review", provider: "local-direct", model: "qwen3.8-flash-next",
    groupId: "gpu3090-qwen", providerBudgetId: "gpu3090-qwen", workKey: "candidate:42", logicalWorkKey: null, ownerInstanceId: "m3-reviewer",
    dispatchedAt: "2026-11-07T05:17:52.000Z", markedAt: "2026-11-07T05:19:55.000Z", reason: "client_timeout" as const, oldPolicy: false, localEndRecorded: true };
  const audit = (id: number, action: string, over: Record<string, unknown> = {}) => ({ id, action, actor: "jr", target: "review-cli", ok: true, error: null,
    detail: { changes: [{ path: "routes.limits.review-cli.timeoutMs", before: 45000, after: 60000 }] }, ip: "100.1.1.1", userAgent: "Mozilla", actorKind: "github",
    createdAt: new Date(Date.parse(LLM_NOW) - 5 * 60_000), ...over });
  beforeEach(() => {
    mocks.reviewQueue.mockResolvedValue({ items: [item], truncated: false, error: null, groups: [{ routeId: "crawl-agent-review", count: 1 }, { routeId: "human-deepseek-review", count: 2 }] });
    mocks.auditRows.mockResolvedValue([audit(25500, "runtime-settings-save"), audit(25499, "model-capacity-unknown-requeued", { ok: false, error: "some_routes_failed", detail: { routeId: "crawl-agent-review", closed: 0 } })]);
  });

  it("재실행 대기(단계별 묶음 · 다시 대기열 · 사유 받는 닫기) → 1시간 실패 → 호출 기록 → 변경 기록 한 표", async () => {
    const html = renderToStaticMarkup(await ModelsHistorySlot({ filter: { kind: null, failedOnly: false, before: null }, readOnly: false }));
    const retry = html.match(/<section class="llm-panel" id="retry"[^]*?<\/section>/)![0];
    expect(text(retry)).toContain("결과 미확정 3건");
    expect(retry).toMatch(/data-retry-route="crawl-agent-review"[^]*?1차 AI 검수[^]*?qwen3.8-flash-next[^]*?시간 초과 1[^]*?로컬 종료 기록 1[^]*?>다시 대기열<\/button>/);
    // 서버가 다시 대기열을 지원하지 않는 단계는 단추 없이 한 건씩 닫게 한다
    expect(retry).toMatch(/data-retry-route="human-deepseek-review"[^]*?아직 지원하지 않습니다/);
    expect(retry).toContain(`id="rv-${item.requestId}"`);
    expect(retry).toContain("mlx-lm 은 취소가 없어");
    expect(retry).toContain('placeholder="닫는 사유(엔진 상태·조치)"');
    expect(retry).toContain(">닫기</button>");
    expect(retry).not.toContain("window.confirm");
    expect(html).toContain('id="failures"');
    expect(html).toContain("호출 기록 · 업무 결과 대조");
    expect(html).toContain("161d7780");
    const audit = html.match(/<section class="llm-panel" id="audit"[^]*?<\/section>/)![0];
    expect(audit).toContain('data-audit-action="runtime-settings-save"');
    expect(text(audit)).toContain("실시간 한도 저장");
    expect(text(audit)).toContain("routes.limits.review-cli.timeoutMs: 45000 → 60000");
    expect(text(audit)).toMatch(/확인 못한 모델 호출 다시 대기열 ▲?■? ?실패 some_routes_failed/);
    expect(audit).toContain('href="/admin/models/history?kind=limit#audit"');
    expect(audit).toContain('href="/admin/models/history?failed=1#audit"');
    expect(audit).toContain('href="/admin/activity?workspace=models&amp;group=llm"');
    expect(mocks.auditRows).toHaveBeenCalledWith(41);
  });

  it("읽지 못하면 0건으로 꾸미지 않는다 · 읽기 전용에서는 단추·닫기 폼이 없다", async () => {
    mocks.reviewQueue.mockResolvedValue({ items: [], truncated: false, error: "statement timeout", groups: [] });
    mocks.observation.mockResolvedValue(unavailableAdminModels());
    mocks.auditRows.mockRejectedValue(new Error("db down"));
    const html = renderToStaticMarkup(await ModelsHistorySlot({ filter: { kind: "limit", failedOnly: true, before: 100 }, readOnly: true }));
    expect(text(html)).toContain("재실행 목록을 읽지 못했습니다");
    expect(text(html)).toContain("변경 기록을 읽지 못했습니다");
    expect(html).toMatch(/id="failures"[^]*?확인 불가/);
    expect(html).not.toContain(">다시 대기열</button>");
    expect(html).toContain('class="llm-filter active" aria-current="page" href="/admin/models/history?kind=limit&amp;failed=1#audit"');
  });
});

describe("옛 주소는 새 화면으로 넘긴다", () => {
  it.each([["tasks", "/admin/models/tasks"], ["connections", "/admin/models/llm"], ["capacity", "/admin/models/llm"], ["history", "/admin/models/history"], ["live", "/admin/models"]])(
    "/admin/models?tab=%s → %s", async (tab, href) => {
      const { default: ModelsPage } = await import("@/app/(operator)/admin/models/page");
      await expect(ModelsPage({ searchParams: Promise.resolve({ tab }) })).rejects.toThrow(`NEXT_REDIRECT:${href}`);
    });
  it("advanced=1 이 붙으면 tab 과 상관없이 고급 설정(/admin/models/advanced)으로 넘긴다", async () => {
    const { default: ModelsPage } = await import("@/app/(operator)/admin/models/page");
    await expect(ModelsPage({ searchParams: Promise.resolve({ tab: "live", advanced: "1" }) })).rejects.toThrow("NEXT_REDIRECT:/admin/models/advanced");
    await expect(ModelsPage({ searchParams: Promise.resolve({ advanced: "1" }) })).rejects.toThrow("NEXT_REDIRECT:/admin/models/advanced");
  });
  it("tab·advanced 가 없으면 넘기지 않고 대시보드를 그린다", async () => {
    const { default: ModelsPage } = await import("@/app/(operator)/admin/models/page");
    await ModelsPage({ searchParams: Promise.resolve({}) });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("연결 저장 + 동시 실행 한도 저장(두 기존 서버 동작)", () => {
  const limit: ConnectionLimitField = { deviceId: "gpu3090-qwen", current: 5, expectedVersion: 3, policyHash: "a".repeat(64), eligible: true, reason: null, sharedWith: [] };
  const form = (values: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(values)) data.set(key, value); return data; };
  const actions = () => ({ connection: vi.fn(async () => ({ ok: true as const, message: "저장했습니다.", connectionId: GPU })),
    device: vi.fn(async () => ({ ok: true as const, message: "장비 저장." })) });
  it("한도가 그대로면 연결만 저장한다", async () => {
    const fake = actions();
    expect(await saveConnectionWithLimit(limit, form({ capacitySlots: "5", deviceId: "gpu3090-qwen" }), fake)).toMatchObject({ ok: true, message: "저장했습니다." });
    expect(fake.device).not.toHaveBeenCalled();
  });
  it("바꾸면 같은 장비 행을 공유 한도 저장(shared-limit)으로 — 판·정책 hash 를 넘긴다", async () => {
    const fake = actions();
    const result = await saveConnectionWithLimit(limit, form({ capacitySlots: "4", deviceId: "gpu3090-qwen" }), fake);
    expect(result).toMatchObject({ ok: true, message: "저장했습니다. 동시 실행 한도: 장비 저장." });
    const sent = (fake.device.mock.calls[0] as unknown as [null, FormData])[1];
    expect(Object.fromEntries(sent.entries())).toEqual({ formMode: "shared-limit", deviceId: "gpu3090-qwen", limitSlots: "4", expectedVersion: "3", policyHash: "a".repeat(64) });
  });
  it("장비 이름을 바꿨거나 저장할 수 없는 장비면 한도는 저장하지 않고 알린다, 한도 저장이 거절되면 그 까닭을 보인다", async () => {
    const renamed = actions();
    expect((await saveConnectionWithLimit(limit, form({ capacitySlots: "4", deviceId: "other" }), renamed))?.warnings?.[0]).toContain("장비 이름을 바꿔");
    expect(renamed.device).not.toHaveBeenCalled();
    const blocked = actions();
    await saveConnectionWithLimit({ ...limit, eligible: false }, form({ capacitySlots: "4", deviceId: "gpu3090-qwen" }), blocked);
    expect(blocked.device).not.toHaveBeenCalled();
    const refused = actions();
    refused.device.mockResolvedValueOnce({ issues: ["다른 곳에서 한도를 바꿨습니다."] } as never);
    expect((await saveConnectionWithLimit(limit, form({ capacitySlots: "4", deviceId: "gpu3090-qwen" }), refused))?.issues)
      .toEqual(["연결은 저장했지만 동시 실행 한도는 저장하지 못했습니다: 다른 곳에서 한도를 바꿨습니다."]);
    const failed = actions();
    failed.connection.mockResolvedValueOnce({ issues: ["입력을 확인하세요: 주소."] } as never);
    await saveConnectionWithLimit(limit, form({ capacitySlots: "4", deviceId: "gpu3090-qwen" }), failed);
    expect(failed.device).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { unavailableAdminModels } from "@/lib/operations/admin-models-observation";
import { buildDashboardView, buildLlmOpsView, llmReasonLevel, llmReasonShort, parseClassifierObservation, type LlmOpsInput } from "@/lib/operations/llm-ops-view";
import { modelsLegacyTabHref, resolveWorkspace, WORKSPACE_SECONDARY } from "@/app/(operator)/admin/workspace-navigation";
import { CLAUDE, GPU, LLM_NOW, llmClassifier, llmCliContracts, llmConnections, llmConveyor, llmJobs, llmObservation, llmRankRows, llmRuntime, M1, OPENCODE, SUPA } from "./fixtures/llm-ops";


const dashboard = (patch: Partial<Parameters<typeof buildDashboardView>[0]> = {}) => buildDashboardView({ now: LLM_NOW, observation: llmObservation(),
  conveyor: llmConveyor(), jobs: llmJobs, connections: llmConnections, ...patch });
const llm = (patch: Partial<LlmOpsInput> = {}) => buildLlmOpsView({ now: LLM_NOW, observation: llmObservation(), connections: llmConnections, rows: llmRankRows,
  executions: [], runtime: llmRuntime, jobs: llmJobs, cliContracts: llmCliContracts, classifier: llmClassifier, ...patch });
const query = (raw: string) => new URLSearchParams(raw);

describe("까닭 코드 → 짧은 말", () => {
  it.each([
    ["no_direct_contract", "계약 없음"], ["cli_contract_missing", "계약 없음"], ["connection_key_missing", "키 없음"], ["connection_disabled", "연결 꺼짐"],
    ["invalid_output", "출력 형식"], ["engine_slow", "시간 초과"], ["client_timeout", "시간 초과"], ["engine_network", "서버 응답 없음"], ["unreachable", "서버 응답 없음"],
    ["http_401", "키 거절(HTTP 401)"], ["http_503", "서버 오류(HTTP 503)"], ["http_404", "HTTP 404"],
  ])("%s → %s", (code, text) => expect(llmReasonShort(code)).toBe(text));
  it("모르는 코드는 지어내지 않고 그대로, 없으면 null", () => {
    expect(llmReasonShort("brand_new_code")).toBe("brand_new_code");
    expect(llmReasonShort(null)).toBeNull();
  });
  it("설정·계약·키·서버 까닭은 멈춤(bad), 이 틱만 쉬는 까닭은 주의(warn), 꺼둔 것은 쉼(idle)", () => {
    expect(llmReasonLevel("no_direct_contract")).toBe("bad");
    expect(llmReasonLevel("engine_network")).toBe("bad");
    expect(llmReasonLevel("capacity")).toBe("warn");
    expect(llmReasonLevel("engine_slow")).toBe("warn");
    expect(llmReasonLevel("rank_disabled")).toBe("idle");
  });
});

describe("대시보드 화면 모형", () => {
  it("KPI 4개를 장부에서 센다 — 실행 중/전체 칸(장비 행 한도 합), 대기, 1시간 정산·성공/실패, 재실행 대기(미확정)", () => {
    const view = dashboard();
    expect(view.readable).toBe(true);
    expect(view.kpis.map(kpi => [kpi.id, kpi.value, kpi.level])).toEqual([
      // dispatched 1+2+1 = 4, 장비 행 한도 5+1+2+1+4+2+2 = 17
      ["running", "4 / 17", "ok"], ["waiting", "9", "warn"], ["settled", "396", "warn"], ["retry", "1", "warn"]]);
    expect(view.kpis[2].foot).toBe("성공 394 · 실패 2");
    expect(view.admission).toMatchObject({ mode: "open", text: "OPEN", level: "ok" });
  });
  it("장비 점유 막대는 장비 행 한도와 예약+실행을 쓰고, 이름은 그 장비를 쓰는 연결·CLI 도구다", () => {
    const view = dashboard();
    const gpu = view.devices.find(device => device.deviceId === "gpu3090-qwen")!;
    expect(gpu).toMatchObject({ label: "gpu3090-qwen", held: 2, limit: 5, percent: 40, waiting: 4, level: "ok" });
    expect(view.devices.find(device => device.deviceId === "m3-opencode-host")).toMatchObject({ held: 1, limit: 1, level: "warn", label: "M3 OpenCode(OpenCode CLI)" });
    expect(view.devices.find(device => device.deviceId === "openai-cli")?.label).toBe("Codex CLI");
  });
  it("판단 띠·먼저 할 일은 실제 상태에서 나오고 할 일은 셋까지, 고칠 곳으로 간다", () => {
    const view = dashboard();
    expect(view.banner.level).toBe("warn");
    expect(view.banner.title).toBe("결과 미확정 1건이 재실행을 기다립니다.");
    expect(view.banner.lines).toEqual(expect.arrayContaining(["최근 1시간 실패 2건(성공 394건).", "검색·후처리 단계를 확인하세요."]));
    expect(view.banner.lines.at(-1)).toBe("의도적 중지(잡 일시중지): 검색 키워드 검수 · 소개 검수");
    expect(view.todos.map(todo => todo.id)).toEqual(["indeterminate", `limit-${GPU}`, `limit-${SUPA}`]);
    expect(view.todos[0]).toMatchObject({ href: "/admin/models?advanced=1#review", action: "다시 대기열·닫기" });
    expect(view.todos[0].detail).toContain("1차 AI 검수 · qwen3.8-flash-next · 2시간 0분 전 · 로컬 종료 기록 있음");
    expect(view.todos[1]).toMatchObject({ href: `/admin/models/llm?edit=${GPU}#conn-${GPU}`, detail: "연결 폼의 칸 수 4, 장비 행 5(으)로 적용 중 — 실제로 쓰는 값은 장비 행입니다." });
    // OpenCode 한도 불일치(2/1)·m1 목록 못 읽음·잡 일시중지 둘은 셋 밖으로 밀린다
    expect(view.moreTodos).toBe(4);
  });
  it("멈춘 단계가 있으면 그 단계가 할 일 맨 앞이고 판단 띠는 멈춤이다", () => {
    const view = dashboard({ conveyor: llmConveyor({ second: ["jam", "모델 없음 — 멈춤", "2차 AI 검수: 순위를 채우세요"] }) });
    expect(view.banner.level).toBe("bad");
    expect(view.todos[0]).toMatchObject({ id: "stage-second", level: "bad", title: "AI 2차 모델 없음 — 멈춤", href: "/admin/models/tasks#execution-second-review-1" });
  });
  it("단계 띠: 현재 모델·상태를 보이고, 잡이 멈춘 작업은 의도적 중지(일부면 단계 안에 적는다)", () => {
    const stages = Object.fromEntries(dashboard().stages.map(stage => [stage.id, stage]));
    expect(Object.keys(stages)).toEqual(["first", "second", "human", "profile", "publish", "keywords", "support"]);
    expect(stages.first).toMatchObject({ level: "ok", status: "흐름", model: "deepseek-v4.1-flash · M3 OpenCode 외 1" });
    expect(stages.first.detail).toBe("최근 1시간 실패 2건");
    expect(stages.keywords).toMatchObject({ level: "warn", status: "쌓임" });
    expect(stages.keywords.detail).toMatch(/^일부 중지: 검색 키워드 검수 · /);
    expect(stages.support.detail).toBe("일부 중지: 소개 검수");
    const allPaused = buildDashboardView({ now: LLM_NOW, observation: llmObservation(), conveyor: llmConveyor(), connections: llmConnections,
      jobs: [{ name: "crawl-publish", paused: true }] });
    expect(allPaused.stages.find(stage => stage.id === "publish")).toMatchObject({ level: "idle", status: "의도적 중지", detail: "잡 일시중지: 카테고리 분류" });
  });
  it("장부를 못 읽으면 0 이 아니라 「확인 불가」, 흐름을 못 읽으면 단계도 확인 불가", () => {
    const view = dashboard({ observation: unavailableAdminModels(), conveyor: null, jobs: null });
    expect(view.readable).toBe(false);
    expect(view.kpis.every(kpi => kpi.value === "확인 불가" && kpi.level === "unknown")).toBe(true);
    expect(view.admission).toMatchObject({ mode: null, text: "확인 불가", level: "unknown" });
    expect(view.banner.level).toBe("unknown");
    expect(view.banner.title).toContain("읽지 못했습니다");
    expect(view.devices).toEqual([]);
    expect(view.stages.every(stage => stage.level === "unknown" && stage.status === "확인 불가")).toBe(true);
    expect(JSON.stringify(view.kpis)).not.toMatch(/"value":"0"/);
  });
  it("DRAIN 이면 판단 띠가 주의이고 할 일 맨 앞이 접수 칸이다", () => {
    const observation = { ...llmObservation(), mode: "draining" as const };
    const view = dashboard({ observation });
    expect(view.admission).toMatchObject({ text: "DRAINING", level: "warn" });
    expect(view.todos[0]).toMatchObject({ id: "drain", href: "#admission" });
  });
});

describe("LLM 운영 화면 모형 — 연결 행", () => {
  it("연결 한 줄에 모델·장비 행 한도/점유·배정된 작업(순위)·상태·재실행 대기를 담고, 연결 폼 칸 수가 장비 행과 다르면 표시한다", () => {
    const view = llm();
    const gpu = view.rows.find(row => row.key === GPU)!;
    expect(gpu).toMatchObject({ source: "connection", kindText: "API", address: "100.77.43.63:8090", keyText: "키 없음", retry: 1 });
    expect(gpu.capacity).toMatchObject({ limit: 5, held: 2, stored: 4, mismatch: true, text: "2 / 5", note: "연결 폼 4칸과 다름 — 장비 행 5칸이 적용됨" });
    expect(gpu.tasks.map(chip => [chip.label, chip.rank])).toEqual([["1차 AI 검수", 2]]);
    expect(gpu.status).toMatchObject({ level: "warn", text: "미확정 있음", reason: "재실행 대기 1건" });
    expect(gpu.limitForm).toMatchObject({ deviceId: "gpu3090-qwen", current: 5, expectedVersion: 3, eligible: true, reason: null });
    const mlx = view.rows.find(row => row.anchor.endsWith("22222222-2222-4222-8222-222222222222"))!;
    expect(mlx.capacity?.mismatch).toBe(false);
    expect(mlx.tasks.map(chip => `${chip.rank} ${chip.label}`)).toEqual(["1 2차 AI 검수 · 투표자 2", "1 수집 소개 짓기", "1 검색 키워드 짓기", "2 검색 키워드 짓기"]);
    expect(mlx.modelTasks["qwen3.6-35b-heretic"]).toBeUndefined();
    expect(mlx.modelTasks["gpt-oss-120b"]).toHaveLength(3);
  });
  it("운영 상태의 까닭: 실행 쪽이 30분 안에 남긴 순위 사정을 짧은 말로, 장부 실패와 함께(오래된 관측은 쓰지 않는다)", () => {
    const view = llm();
    const opencode = view.rows.find(row => row.key === OPENCODE)!;
    expect(opencode).toMatchObject({ kindText: "CLI · OpenCode CLI", version: "2.2.6", versionSource: "연결" });
    expect(opencode.status.level).toBe("warn");
    expect(opencode.status.reason).toBe("1시간 정산 86 · 실패 2 · 시간 초과 1회(1차 AI 검수)");
    expect(view.rows.find(row => row.key === M1)!.status).toMatchObject({ level: "bad", text: "목록 못 읽음", reason: "서버 응답 없음" });
    // crawl-tagline 의 계약 없음은 2시간 전 관측이라 m3-mlx 에 붙이지 않는다
    expect(view.rows.find(row => row.key === "22222222-2222-4222-8222-222222222222")!.status).toMatchObject({ level: "ok", text: "정상" });
    const supa = view.rows.find(row => row.key === SUPA)!;
    expect(supa.tasks.find(chip => chip.task === "product-search-verify")).toMatchObject({ paused: true, rank: 1 });
    expect(supa.capacity).toMatchObject({ mismatch: true, stored: 20, limit: 2 });
  });
  it("정책 경로가 없는 장비는 여기서 한도를 저장할 수 없다고 까닭을 준다", () => {
    const m1 = llm().rows.find(row => row.key === M1)!;
    expect(m1.limitForm).toMatchObject({ eligible: false });
    expect(m1.limitForm?.reason).toContain("정책 경로가 아직 없습니다");
  });
  it("CLI 도구는 연결 행이 없어도 정책 경로·장부·CLI 계약·분류 설정에서 모아 한 줄씩 보인다(Codex·Grok), 연결이 있는 도구는 그 행에 덧붙인다(Claude)", () => {
    const view = llm();
    expect(view.totals).toMatchObject({ connections: 6, cliTools: 2 });
    const codex = view.rows.find(row => row.key === "cli:codex-cli")!;
    expect(codex).toMatchObject({ source: "cli-tool", label: "Codex CLI", version: "codex-cli 0.98.0", versionSource: "분류 에이전트 관측", address: "장비 openai-cli" });
    expect(codex.capacity).toMatchObject({ deviceId: "openai-cli", text: "0 / 2", stored: null, mismatch: false });
    expect(codex.tasks.map(chip => [chip.label, chip.rank, chip.source])).toEqual([["카테고리 분류", 1, "classifier"]]);
    expect(codex.status).toMatchObject({ level: "ok", text: "정상", reason: "1시간 정산 12" });
    expect(codex.editLinks.map(link => link.href)).toContain("/admin/status?tab=ai");
    const grok = view.rows.find(row => row.key === "cli:grok-cli")!;
    expect(grok).toMatchObject({ label: "Grok CLI", version: "0.9.1", versionSource: "계약", capacity: null });
    expect(grok.tasks.map(chip => chip.label)).toEqual(["Grok 로그인 유지"]);
    expect(grok.models.ids).toEqual(["grok-4.7"]);
    const claude = view.rows.find(row => row.key === CLAUDE)!;
    expect(claude.tasks.map(chip => `${chip.rank ?? "-"} ${chip.label} ${chip.source}${chip.paused ? " 중지" : ""}`)).toEqual(["2 카테고리 분류 classifier", "- 소개 검수 policy 중지"]);
    expect(claude.editLinks).toEqual([{ href: "/admin/status?tab=ai", label: "분류 모델 설정" }]);
    // OpenCode 연결이 있으니 opencode-cli 도구 행은 따로 생기지 않는다
    expect(view.rows.some(row => row.key === "cli:opencode-cli")).toBe(false);
  });
  it("잘 알려진 CLI 장비 행(openai-cli)만 있어도 Codex 행이 생긴다", () => {
    const observation = llmObservation();
    const view = llm({ observation: { ...observation, configuredRoutes: [], rows: observation.rows.filter(row => row.provider !== "codex-cli") }, classifier: null });
    expect(view.rows.find(row => row.key === "cli:codex-cli")).toMatchObject({ address: "장비 openai-cli", status: { level: "idle", text: "배정 없음" } });
  });
  it("장부를 못 읽으면 점유·재실행은 「확인 불가」(0 아님), 한도 저장은 막는다", () => {
    const view = llm({ observation: unavailableAdminModels(), runtime: null });
    const gpu = view.rows.find(row => row.key === GPU)!;
    expect(gpu.capacity).toMatchObject({ text: "확인 불가", held: null, level: "unknown" });
    expect(gpu.retry).toBeNull();
    expect(gpu.status).toMatchObject({ level: "unknown", text: "확인 불가" });
    expect(gpu.limitForm?.eligible).toBe(false);
    expect(view.totals.limitSum).toBeNull();
    expect(view.errors).toEqual(expect.arrayContaining([expect.stringContaining("LLM 장부"), expect.stringContaining("실행 쪽 순위 사정")]));
  });
  it("꺼진 연결은 꺼짐(쉼)으로만 보인다", () => {
    const view = llm({ connections: llmConnections.map(row => row.id === GPU ? { ...row, enabled: false } : row) });
    expect(view.rows.find(row => row.key === GPU)!.status).toMatchObject({ level: "idle", text: "꺼짐" });
  });
});

describe("connect 에이전트 관측 읽기", () => {
  it("우선·예비 모델과 도구, 분류 수락, 에이전트가 확인한 CLI 버전만 꺼낸다(모양이 틀린 칸은 버린다)", () => {
    const parsed = parseClassifierObservation("2026-11-07T07:19:00.000Z", { classifyReady: false,
      config: { primary: { model: "gpt-5.6-terra" }, fallback: { model: "bad model with spaces" } },
      modelOptions: [{ model: "gpt-5.6-terra", provider: "codex-cli" }],
      classificationContracts: [{ provider: "codex-cli", cliVersion: "codex-cli 0.98.0", apiKey: "SECRET" }, { provider: "x", cliVersion: "1" }] }, Date.parse(LLM_NOW));
    expect(parsed).toEqual({ observedAt: "2026-11-07T07:19:00.000Z", fresh: true, ready: false, models: [{ rank: 1, model: "gpt-5.6-terra", provider: "codex-cli" }],
      versions: [{ provider: "codex-cli", cliVersion: "codex-cli 0.98.0" }] });
    expect(parseClassifierObservation("2026-11-07T06:00:00.000Z", {}, Date.parse(LLM_NOW))?.fresh).toBe(false);
    expect(parseClassifierObservation("not-a-time", {}, Date.parse(LLM_NOW))).toBeNull();
  });
});

describe("옛 주소 → 새 화면", () => {
  it.each([
    ["tab=live", "/admin/models"], ["tab=tasks", "/admin/models/tasks"], ["tab=connections", "/admin/models/llm"],
    ["tab=capacity", "/admin/models/llm"], ["tab=history", "/admin/models/history"], ["tab=unknown", "/admin/models"],
  ])("/admin/models?%s → %s", (search, href) => expect(modelsLegacyTabHref(query(search))).toBe(href));
  it("tab 이 없거나 advanced=1 이면 넘기지 않는다(옛 #review·#model-settings 링크가 그대로 산다)", () => {
    expect(modelsLegacyTabHref(query(""))).toBeNull();
    expect(modelsLegacyTabHref(query("tab=live&advanced=1"))).toBeNull();
    expect(modelsLegacyTabHref(query("advanced=1"))).toBeNull();
  });
  it.each([
    ["/admin/models", "", "dashboard"], ["/admin/models", "tab=capacity", "llm"], ["/admin/models", "tab=history", "history"],
    ["/admin/models", "advanced=1", "advanced"], ["/admin/models", "tab=live&advanced=1", "advanced"],
    ["/admin/models/llm", "", "llm"], ["/admin/models/tasks", "", "tasks"], ["/admin/models/history", "", "history"],
    ["/admin/models/devices", "", "advanced"], ["/admin/models/limits", "", "advanced"], ["/admin/models/helpers", "", "advanced"],
    ["/admin/models/assignments", "", "advanced"], ["/admin/models/contracts", "", "advanced"], ["/admin/models/human", "", "advanced"],
    ["/admin/models/search", "", "advanced"], ["/admin/activity", "workspace=models", "history"],
  ])("%s?%s 는 LLM 운영의 %s 탭", (path, search, tab) => {
    const location = resolveWorkspace(path, query(search));
    expect(location.workspace.id).toBe("models");
    expect(location.tab).toBe(tab);
    expect(location.secondary).toEqual(tab === "advanced" ? WORKSPACE_SECONDARY.modelsAdvanced : []);
  });
});

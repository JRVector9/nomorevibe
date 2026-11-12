import { describe, expect, it } from "vitest";
import { aiConnectionInputFromForm, aiModelDisplayName, aiModelMachine } from "@/lib/operations/admin-ai-tasks";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { buildModelConsole, checkModelAddStepOne, checkModelAddStepTwo, connectionFormEntries, deviceRowFormEntries, modelSavePlan, modelSettingsOf,
  recommendStages, servedModelGroups, type ModelConsoleRow } from "@/lib/operations/model-console";
import { SAMPLE_COMPARE_SUPPORTED } from "@/lib/operations/model-sample-compare";
import { consoleFixtureInputs } from "./fixtures/console-home";
import { modelFixtureDevices, modelFixtureInput } from "./fixtures/model-console";

const view = () => buildModelConsole(modelFixtureInput());
const byLabel = (label: string): ModelConsoleRow => view().rows.find(row => row.connection.label === label)!;
const form = (entries: [string, string][]) => { const data = new FormData(); for (const [name, value] of entries) data.append(name, value); return data; };

describe("모델 한 줄 = 사용자가 정한 이름 하나", () => {
  it("연결 아홉 개가 아홉 줄 — supa 의 두 이름(supa · Inferact/…)은 한 줄이고, 연결 확인에서 root 로 한 묶음이다", () => {
    const rows = view().rows;
    expect(rows).toHaveLength(9);
    const supa = rows.filter(row => row.connection.label === "supa-direct");
    expect(supa).toHaveLength(1);
    expect(supa[0].served).toEqual([{ ids: ["supa", "Inferact/Qwen3.8-27B-NVFP4"], root: "Inferact/Qwen3.8-27B-NVFP4", maxModelLen: 131_072 }]);
    // 두 이름 모두의 장부가 이 한 줄에 모인다(supa 6,536 + 1,780 · Inferact 88)
    expect(supa[0].calls).toBe(8_404);
  });

  it("root 를 모르면 이름 하나가 한 묶음 — 다른 모델을 지어 합치지 않는다", () => {
    expect(servedModelGroups({ kind: "api", models: [{ id: "a", maxModelLen: null }, { id: "b", maxModelLen: 10 }], cliModels: [] }).map(group => group.ids))
      .toEqual([["a"], ["b"]]);
    // 별칭의 원래 이름(root)이 목록에 따로 있으면 그 묶음에 든다
    expect(servedModelGroups({ kind: "api", models: [{ id: "x", maxModelLen: null, root: "base" }, { id: "base", maxModelLen: null }], cliModels: [] }).map(group => group.ids))
      .toEqual([["x", "base"]]);
  });

  it("이름은 사용자가 정한 이름, 없으면 이름표 — 장비는 사용자가 적은 묶음 이름, 없으면 장비 id", () => {
    expect(aiModelDisplayName({ label: "supa-direct" })).toBe("supa-direct");
    expect(aiModelDisplayName({ label: "supa-direct", displayName: "supa" })).toBe("supa");
    expect(aiModelDisplayName({ label: "supa-direct", displayName: "  " })).toBe("supa-direct");
    expect(aiModelMachine({ deviceId: "m3-mlx" })).toBe("m3-mlx");
    expect(aiModelMachine({ deviceId: "m3-mlx", machine: "M3 Ultra" })).toBe("M3 Ultra");
    const renamed = buildModelConsole(modelFixtureInput({ connections: modelFixtureInput().connections!.map(row => row.id === "conn-supa-direct"
      ? { ...row, displayName: "supa", machine: "Supa" } : row) })).rows.find(row => row.id === "conn-supa-direct")!;
    expect([renamed.name, renamed.machine, renamed.deviceId]).toEqual(["supa", "Supa", "supa-direct"]);
  });
});

describe("사용률·상태(시안 build.py 와 같은 식·같은 순서)", () => {
  it.each([
    // 이름표, 한도, 지금, 사용률, 호출, 평균 응답, 단계 수, 상태
    ["m3-deepseek", 1, 1, "54%", 5_887, "7.9", 6, "정상"],
    ["supa-direct", 3, 3, "49%", 8_404, "15.5", 3, "미확정 19"],
    ["m3-gpt-oss", 2, 1, "38%", 9_142, "7.2", 6, "정상"],
    ["M3 OpenCode", 2, 0, "18%", 2_600, "15.3", 1, "정상"],
    ["m1-gemma", 2, 1, "15%", 3_457, "7.7", 3, "정상"],
    ["gpu3090-qwen", 5, 0, "1%", 2_242, "2.5", 10, "여유 많음"],
    ["LG EXAONE", 1, 0, "1% 미만", 135, "2.2", 1, "결과 없이 끝남 57"],
    ["M1max", 2, 0, "0%", 0, null, 0, "쓰는 단계 없음"],
    ["Claude CLI", 2, 0, "0%", 0, null, 1, "쓰는 단계가 멈춤"],
  ] as const)("%s — 한도 %i · 지금 %i · %s · 호출 %i", (label, limit, active, utilization, calls, avg, stages, status) => {
    const row = byLabel(label);
    expect([row.limit, row.active, row.utilizationText, row.calls, row.avgSeconds === null ? null : row.avgSeconds.toFixed(1), row.stageCount, row.status.text])
      .toEqual([limit, active, utilization, calls, avg, stages, status]);
  });

  it("사용률 높은 순 — 같으면 이름 순", () => {
    expect(view().rows.map(row => row.connection.label)).toEqual(["m3-deepseek", "supa-direct", "m3-gpt-oss", "M3 OpenCode", "m1-gemma", "gpu3090-qwen", "LG EXAONE",
      "Claude CLI", "M1max"]);
  });

  it("한도는 장비의 모델별 한도 → 장비 한도 → 연결 칸 수 순서로 실제 걸리는 값", () => {
    expect([byLabel("m3-gpt-oss").limitSource, byLabel("gpu3090-qwen").limitSource]).toEqual(["model", "device"]);
    const noDevices = buildModelConsole(modelFixtureInput({ devices: [] })).rows.find(row => row.id === "conn-gpu3090-qwen")!;
    expect([noDevices.limit, noDevices.limitSource, noDevices.active]).toEqual([5, "connection", 0]);
  });

  it("쉬는 모델은 「쉬는 중」 — 다른 문제보다 앞선다", () => {
    const rows = buildModelConsole(modelFixtureInput({ connections: modelFixtureInput().connections!.map(row => row.id === "conn-lg-exaone" ? { ...row, enabled: false } : row) })).rows;
    expect(rows.find(row => row.id === "conn-lg-exaone")!.status).toEqual({ tone: "off", text: "쉬는 중" });
  });

  it("읽지 못한 값은 0 으로 꾸미지 않는다 — 장부·장비를 못 읽으면 「—」와 까닭", () => {
    const missing = buildModelConsole(modelFixtureInput({ ledger: null, devices: null }));
    const row = missing.rows.find(entry => entry.id === "conn-m3-deepseek")!;
    expect([row.calls, row.utilization, row.utilizationText, row.active, row.status.text]).toEqual([null, null, "—", null, "사용량 확인 불가"]);
    expect(missing.errors).toEqual(expect.arrayContaining([expect.stringContaining("24시간 장부"), expect.stringContaining("장비 점유")]));
  });

  it("문제는 읽은 사실만 — 결과 없이 끝남 · 키 만료 날짜", () => {
    const exaone = byLabel("LG EXAONE");
    expect(exaone.problems.map(problem => problem.label)).toEqual(["거절"]);
    expect(exaone.problems[0].text).toBe("24시간 135건 중 57건이 결과 없이 끝났습니다(공급자가 처리 전에 거절했거나 보내지 못함).");
    const near = buildModelConsole(modelFixtureInput({ now: "2026-12-07T00:00:00.000Z" })).rows.find(row => row.id === "conn-lg-exaone")!;
    expect(near.problems.find(problem => problem.key === "key")?.text).toBe("키가 4일 뒤(12-11) 만료됩니다.");
  });
});

describe("저장 전 확인 — 바뀌는 값 전 → 후 · 함께 쓸 곳 · 영향", () => {
  const device = (id: string) => modelFixtureDevices().find(row => row.deviceId === id) ?? null;

  it("모델별 한도가 있는 장비(m3-mlx): 동시 한도 2 → 3 은 그 모델 줄만 바꾸고 다른 모델 줄·장비 한도는 그대로 싣는다", () => {
    const row = byLabel("m3-gpt-oss");
    const plan = modelSavePlan(row, device("m3-mlx"), { ...modelSettingsOf(row), limit: 3 });
    expect(plan.lines).toEqual([{ key: "limit", label: "동시 한도", before: "2", after: "3" }]);
    expect(plan.writes).toEqual(["연결 칸 수 2 → 3", "장비 m3-mlx의 모델별 한도(gpt-oss-120b) 2 → 3"]);
    expect(plan.device).toEqual({ deviceId: "m3-mlx", expectedVersion: 6, limitSlots: 3, modelLimits: [
      { model: "deepseek-v4.1-flash-1017", maxSlots: 1, engineMax: 1 }, { model: "gpt-oss-120b", maxSlots: 3, engineMax: 4 }] });
    expect(plan.impacts[0]).toMatch(/^이 모델을 쓰는 단계 6개: /);
    expect(plan.warnings).toEqual([]);
    // 장비 한도보다 크면 저장 전에 알린다(막는 것은 기존 저장의 검증)
    expect(modelSavePlan(row, device("m3-mlx"), { ...modelSettingsOf(row), limit: 4 }).warnings[0]).toMatch(/장비 한도 3보다 큽니다/);
    expect(deviceRowFormEntries(plan.device!)).toEqual([["deviceId", "m3-mlx"], ["expectedVersion", "6"], ["limitSlots", "3"], ["modelLimits", "1"],
      ["model", "deepseek-v4.1-flash-1017"], ["max:deepseek-v4.1-flash-1017", "1"], ["engine:deepseek-v4.1-flash-1017", "1"],
      ["model", "gpt-oss-120b"], ["max:gpt-oss-120b", "3"], ["engine:gpt-oss-120b", "4"]]);
  });

  it("모델별 한도가 없는 장비: 장비 한도도 함께 바꾼다", () => {
    const row = byLabel("gpu3090-qwen");
    const plan = modelSavePlan(row, device("gpu3090-qwen"), { ...modelSettingsOf(row), limit: 6 });
    expect(plan.writes).toEqual(["연결 칸 수 5 → 6", "장비 gpu3090-qwen의 한도 5 → 6"]);
    expect(plan.device).toEqual({ deviceId: "gpu3090-qwen", expectedVersion: 5, limitSlots: 6, modelLimits: null });
  });

  it("쉬게 하기 = 상태 켜짐 → 쉬는 중, 장비는 건드리지 않고 단계가 다음 순위로 넘어간다고 알린다", () => {
    const row = byLabel("LG EXAONE");
    const plan = modelSavePlan(row, device("Exaone"), { ...modelSettingsOf(row), enabled: false });
    expect(plan.lines).toEqual([{ key: "enabled", label: "상태", before: "켜짐", after: "쉬는 중" }]);
    expect(plan.device).toBeNull();
    expect(plan.impacts).toEqual(["이 모델을 쓰는 단계 1개: 한국어 소개 번역(2순위)",
      "쉬는 동안 모든 단계가 이 모델을 건너뛰고 다음 순위·함께 쓰는 모델로 넘어갑니다. 순위는 그대로 남습니다."]);
  });

  it("이름·장비만 바꾸면 단계 영향은 적지 않는다 · 아무것도 안 바꾸면 changed=false", () => {
    const row = byLabel("supa-direct");
    const plan = modelSavePlan(row, device("supa-direct"), { ...modelSettingsOf(row), name: "supa", machine: "Supa" });
    expect(plan.lines.map(line => [line.label, line.before, line.after])).toEqual([["이름", "supa-direct", "supa"], ["장비", "supa-direct", "Supa"]]);
    expect(plan.impacts).toEqual([]);
    expect(modelSavePlan(row, device("supa-direct"), modelSettingsOf(row)).changed).toBe(false);
  });

  it("쓸 수 있는 단계를 좁혀 쓰던 단계가 빠지면 경고한다", () => {
    const row = byLabel("m1-gemma");
    const plan = modelSavePlan(row, device("m1-qwen"), { ...modelSettingsOf(row), allowedTasks: ["reason-translate"] });
    expect(plan.warnings[0]).toMatch(/빠지는 단계가 있습니다: .*수집 소개 짓기/);
  });

  it("기존 연결 저장에 보낼 폼은 고치지 않는 칸을 지금 값 그대로 싣는다 — 연결 폼 읽기로 되돌리면 같은 값", () => {
    // 연결 폼 읽기는 연결 id 를 uuid 로 받는다(자료의 id 는 읽기 쉬운 가짜 id)
    const ID = "4d2c7f1e-0000-4000-8000-00000000e1a0";
    const row = { ...byLabel("LG EXAONE"), connection: { ...byLabel("LG EXAONE").connection, id: ID } };
    const parsed = aiConnectionInputFromForm(form(connectionFormEntries(row.connection, { name: "EXAONE", machine: "LG 클라우드", limit: 1 })));
    expect(parsed.issues).toEqual([]);
    expect(parsed.input).toMatchObject({ id: ID, expectedVersion: 3, label: "LG EXAONE", kind: "api", baseUrl: "https://exaone.example/v1", key: { mode: "keep" }, deviceId: "Exaone", capacitySlots: 1,
      contextTokens: 524_288, enabled: true, manualModels: ["k-exaone_v2.5"], reasoningTokenReserve: 12_800, keyValidDays: 30,
      allowedTasks: ["crawl-tagline", "reason-translate", "product-translate", "product-tagline-ko"], displayName: "EXAONE", machine: "LG 클라우드", note: "비상업 용도 전용" });
    // 이름을 이름표와 같게 두면 따로 저장하지 않는다(빈 값 = 지움)
    expect(aiConnectionInputFromForm(form(connectionFormEntries(row.connection, { name: "LG EXAONE" }))).input).toMatchObject({ displayName: null });
    // 새 키는 그 칸에만, 쉬게 하기는 enabled=0
    const rest = aiConnectionInputFromForm(form(connectionFormEntries(row.connection, { enabled: false, newKey: "k-123" }))).input!;
    expect([rest.enabled, rest.key]).toEqual([false, { mode: "set", value: "k-123" }]);
    // CLI 는 도구·모델·버전을 그대로
    const cli = aiConnectionInputFromForm(form(connectionFormEntries({ ...byLabel("Claude CLI").connection, id: ID }))).input!;
    expect([cli.kind, cli.cliTool, cli.cliModels, cli.cliVersion]).toEqual(["cli", "claude", ["sonnet"], "2.1.0 (Claude Code)"]);
  });
});

describe("모델 추가 세 걸음", () => {
  it("① 넣기 — 주소 꼴을 보고, 이름은 호스트에서 임시로(겹치면 번호)", () => {
    expect(checkModelAddStepOne({ kind: "api", baseUrl: "ftp://x/v1", cliTool: "", cliModels: "" }, []).issues).toEqual(["주소는 OpenAI 호환 http(s)://호스트[:포트]/v1 꼴이어야 합니다."]);
    expect(checkModelAddStepOne({ kind: "api", baseUrl: "https://jr-m1max.example/v1/models", cliTool: "", cliModels: "" }, ["jr-m1max"]))
      .toEqual({ issues: [], label: "jr-m1max (2)", deviceId: "jr-m1max-2", baseUrl: "https://jr-m1max.example/v1" });
    expect(checkModelAddStepOne({ kind: "cli", baseUrl: "", cliTool: "opencode", cliModels: "" }, []).issues).toHaveLength(2);
    expect(checkModelAddStepOne({ kind: "cli", baseUrl: "", cliTool: "claude", cliModels: "sonnet opus" }, [])).toMatchObject({ issues: [], label: "claude sonnet" });
  });

  it("② 이름과 한도 — 이름 필수·겹침, 한도 1~256, 최대 토큰은 비우거나 1~2,097,152", () => {
    expect(checkModelAddStepTwo({ name: "M1max", machine: "M1 Max", limit: "2", maxTokens: "131,072" }, [], "api")).toEqual([]);
    expect(checkModelAddStepTwo({ name: "supa", machine: "", limit: "0", maxTokens: "x" }, ["SUPA"], "api")).toEqual([
      "「supa」은(는) 다른 모델이 쓰는 이름입니다.", "동시 한도는 1~256의 정수입니다.", "최대 토큰은 1~2,097,152의 정수이거나 비워 둡니다."]);
    expect(checkModelAddStepTwo({ name: "", machine: "", limit: "1", maxTokens: "x" }, [], "cli")).toEqual(["이름을 적으세요."]);
  });

  it("③ 쓸 단계 — 홈 「쌓임」과 같은 계산으로 오래 밀린 단계부터, 이 모델을 받는 단계만, 비교 지원 여부와 함께", () => {
    const board = buildConsoleTasks(consoleFixtureInputs());
    const m1max = byLabel("M1max");
    const picks = recommendStages(board, m1max.connection, SAMPLE_COMPARE_SUPPORTED, m1max.models[0]);
    expect(picks.map(pick => pick.task)).toEqual(["product-translate", "reason-translate", "product-search-verify"]);
    expect(picks.map(pick => pick.daysText)).toEqual(["96일 밀림", "30일 밀림", "5.7일 밀림"]);
    // 붙이는 곳은 그 단계 패널의 모델 구역(운영 콘솔 2a)
    expect(picks[0]).toMatchObject({ label: "공개 번역", compare: false, href: "/admin/flow?stage=product-translate#sp-models" });
    // 「쓸 수 있는 단계」를 좁힌 모델은 그 단계만
    const exaone = byLabel("LG EXAONE");
    expect(recommendStages(board, exaone.connection, SAMPLE_COMPARE_SUPPORTED, null).map(pick => pick.task)).toEqual(["product-translate", "reason-translate"]);
    expect(recommendStages(null, m1max.connection, SAMPLE_COMPARE_SUPPORTED, null)).toEqual([]);
  });
});

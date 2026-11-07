import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 실시간 한도 화면(PR 1a WP-D) — 화면 모형·폼 → sparse patch·거절 문장·그리기·server action. DB 없이 본다; WP-A 의 저장 본문은 가짜다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), readRow: vi.fn(), readApply: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/runtime-settings", async importOriginal => ({ ...(await importOriginal<object>()),
  saveRuntimeSettings: mocks.save, readRuntimeSettingsRow: mocks.readRow, readRuntimeSettingsApply: mocks.readApply }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveRuntimeSettingsGroup } from "@/app/(operator)/admin/models/limits/actions";
import { BudgetsForm } from "@/app/(operator)/admin/models/limits/BudgetsForm";
import { RoutesForm } from "@/app/(operator)/admin/models/limits/RoutesForm";
import { TranslationForm } from "@/app/(operator)/admin/models/limits/TranslationForm";
import { SettingsApplyLine } from "@/app/(operator)/admin/settings/SettingsApplyLine";
import { AssignmentsForm } from "@/app/(operator)/admin/models/limits/AssignmentsForm";
import { auditChangeLines, buildAssignmentReadsControl, buildRuntimeSettingsAdminView, fieldLabel, latestRoleObservations, runtimeSettingsIssueMessage,
  runtimeSettingsPatchFromForm, type AdminObservation } from "@/lib/operations/admin-runtime-settings";
import type { AdminLogRow } from "@/lib/operations/admin-log";
import { formatRuntimeSettingsLine, runtimeSettingsReadback } from "@/lib/operations/pipeline-control-status";
import { RUNTIME_SETTING_LABELS } from "@/lib/operations/runtime-settings-schema";

const NOW = new Date("2026-10-30T12:00:00.000Z");
// 공개 번역 호출 상한 290초(모델 m1:translation 의 300초보다 짧아 경로 값이 실제 상한이 된다 — 둘 중 작은 값이 쓰인다)
const STORED = { version: 1, translation: { product: { batchChars: 6_000 } }, routes: { limits: { "product-translate": { timeoutMs: 290_000 } } },
  budgets: { "crawl-tagline": 60_000, "product-search-verify": 65_000 } };
const ROW = { values: STORED, revision: 3, updatedBy: "jr", updatedAt: "2026-10-30T11:50:00.000Z" };
const lane = (job: string, startedAt: number) => ({ name: job, jobs: [job], state: "running", currentJob: job, startedAt, pollStartedAt: null, lastProgressAt: NOW.getTime() - 1_000, budgetMs: 315_000 });
const OBSERVATIONS: AdminObservation[] = [
  { key: "service:text:m3", ageSeconds: 5, value: { status: "running", runtimeSettingsRegistryEnv: true, laneLimits: { progressMs: 90_000, jobMs: 180_000 },
    lanes: [lane("product-translate", NOW.getTime() - 12_000)] } },
  { key: "service:crawler:m3", ageSeconds: 4, value: { status: "running", runtimeSettingsRegistryEnv: false, laneLimits: { jobMs: 120_000 } } },
  // 1분 넘은 관측·consumer 관측은 역할의 지금 상태가 아니다
  { key: "service:reviewer:old", ageSeconds: 300, value: { status: "running", runtimeSettingsRegistryEnv: true } },
  { key: "service:crawler:agent-scan-consumer-m3", ageSeconds: 1, value: { status: "running", runtimeSettingsRegistryEnv: true } },
];
const audit = (over: Partial<AdminLogRow>): AdminLogRow => ({ id: 1, actor: "jr", action: "runtime-settings-save", target: "runtime_settings:translation",
  detail: { revision: 4, changes: [{ path: "product.batchChars", before: 8_000, after: 6_000 }] }, createdAt: NOW, actorKind: "github", ip: null, userAgent: null,
  ok: true, error: null, ...over });
const view = (overrides: Partial<Parameters<typeof buildRuntimeSettingsAdminView>[0]> = {}) =>
  buildRuntimeSettingsAdminView({ row: ROW, observations: OBSERVATIONS, now: NOW, audit: [audit({})], ...overrides });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };

beforeEach(() => {
  mocks.admin.mockReset().mockResolvedValue({ login: "operator" });
  mocks.save.mockReset().mockResolvedValue({ ok: true, revision: 4, version: "abcdef1234567890" });
});

describe("화면 모형 — 유효값·기본값·덮어씀", () => {
  it("저장 문서의 키만 덮어씀이고 나머지는 기본값이다; 이름은 RUNTIME_SETTING_LABELS 에서 온다(ms 칸은 초)", () => {
    const model = view();
    expect(model).toMatchObject({ revision: 3, updatedBy: "jr", rowError: null, issues: [] });
    expect(model.shortVersion).toMatch(/^v[0-9a-f]{6}$/);
    const batchChars = model.translation.find(field => field.path === "translation.product.batchChars")!;
    expect(batchChars).toMatchObject({ value: 6_000, defaultValue: 8_000, overridden: true, input: "6000", defaultInput: "8000", kind: "int" });
    expect(batchChars.label).toBe(RUNTIME_SETTING_LABELS["translation.product.batchChars"]);
    expect(batchChars.label).toBe("공개 번역 묶음 글자 임계");
    expect(model.translation.find(field => field.path === "translation.product.maxSourceChars")).toMatchObject({ overridden: false, input: "30000", note: expect.stringContaining("source_too_long") });
    expect(model.translation.find(field => field.path === "translation.product.batchMax")).toMatchObject({ readOnly: true, input: "4" });
    const margin = model.translation.find(field => field.path === "translation.product.jobMarginMs")!;
    expect(margin).toMatchObject({ kind: "ms", input: "15", defaultInput: "15", label: "공개 번역 틱 여유(초)" });
    expect(fieldLabel("translation.product.jobMarginMs")).toBe(RUNTIME_SETTING_LABELS["translation.product.jobMarginMs"].replace("(ms)", "(초)"));
  });

  it("모델 배정 읽기(3b-E) — 열거 칸 하나: 기본 off, 저장 문서가 on 이면 덮어씀, 선택지와 안내가 붙는다; 배정 화면용 묶음은 행 하나로 만든다", () => {
    const [toggle] = view().assignments;
    expect(toggle).toMatchObject({ path: "assignments.tableReads", label: "배정 표 읽기", kind: "choice", value: "off", defaultValue: "off", input: "off", defaultInput: "off",
      overridden: false, options: [{ value: "off", label: "끔 — 설정(legacy)으로 고른다" }, { value: "on", label: "켬 — 배정 표(live 행)로 고른다" }] });
    expect(toggle.note).toContain("재배포 없음");
    expect(toggle.note).toContain("MODEL_ASSIGNMENT_TABLE");
    const on = view({ row: { ...ROW, values: { ...STORED, assignments: { tableReads: "on" } } } }).assignments[0];
    expect(on).toMatchObject({ value: "on", input: "on", overridden: true, defaultInput: "off" });
    expect(fieldLabel("assignments.tableReads")).toBe("배정 표 읽기");
    const control = buildAssignmentReadsControl({ ...ROW, values: { ...STORED, assignments: { tableReads: "on" } } });
    expect(control).toMatchObject({ revision: 3, rowError: null, fields: [{ path: "assignments.tableReads", input: "on", overridden: true }] });
    expect(buildAssignmentReadsControl(null, "runtime_settings_row_missing")).toMatchObject({ revision: null, rowError: "runtime_settings_row_missing", fields: [{ input: "off", overridden: false }] });
  });

  it("경로 한도 — 호출 상한 칸은 timeouts·limits.timeoutMs·사다리 중 그 경로가 실제로 읽는 자리고, 모델 상한은 등록부에서 읽기 전용으로 붙는다", () => {
    const model = view();
    const translate = model.routes.find(row => row.route === "product-translate")!;
    expect(translate.label).toBe("공개 번역");
    expect(translate.timeout).toMatchObject({ path: "routes.limits.product-translate.timeoutMs", input: "290", defaultInput: "300", overridden: true, label: "공개 번역 호출 상한(초)" });
    expect(translate.maxTokens).toMatchObject({ path: "routes.limits.product-translate.maxTokens", input: "30000", overridden: false });
    expect(translate.modelCeiling).toContain("m1:translation");
    expect(model.routes.find(row => row.route === "crawl-tagline")!.timeout).toMatchObject({ path: "routes.timeouts.crawl-tagline", input: "45" });
    // 시간 상한만 있는 경로는 토큰·동시 칸이 없다
    expect(model.routes.find(row => row.route === "screen-review")).toMatchObject({ maxTokens: null, concurrency: null, timeout: { path: "routes.timeouts.screen-review", input: "90" } });
    // 사다리 경로의 호출 상한은 사다리 클라이언트 기한
    const ladder = model.ladders.find(row => row.route === "review-gateway")!;
    expect(ladder.fields.clientMs).toMatchObject({ input: "60", kind: "ms" });
    expect(ladder.fields.relayMs).toMatchObject({ input: "", value: null });
    expect(ladder.fields.engineMs.note).toContain("선언만");
  });

  it("틱 예산 — auto 는 상한 + 여유로 풀고, 감독 하한·지금 도는 틱·env 등록부는 역할 관측에서 읽는다", () => {
    const model = view();
    const translate = model.budgets.find(row => row.job === "product-translate")!;
    expect(translate).toMatchObject({ auto: true, defaultAuto: true, declared: true, ceilingMs: 290_000, role: "text", roleLabel: "소개·사유 번역",
      autoNote: "= 호출 상한 290초 + 여유 15초 = 305초", supervisorFloorMs: 180_000, lane: { state: "running", currentJob: "product-translate", ageMs: 12_000, budgetMs: 315_000 } });
    expect(translate.field).toMatchObject({ input: "305", defaultInput: "315", overridden: false, label: "공개 번역 틱 예산(초)" });
    // 경로 상한을 모델 상한(300초)보다 길게 적으면 실제 상한은 모델 쪽이다
    expect(view({ row: { ...ROW, values: { version: 1, routes: { limits: { "product-translate": { timeoutMs: 310_000 } } } } } }).budgets.find(row => row.job === "product-translate"))
      .toMatchObject({ ceilingMs: 300_000, autoNote: "= 호출 상한 300초 + 여유 15초 = 315초" });
    expect(model.budgets.find(row => row.job === "crawl-tagline")).toMatchObject({ declared: true, ceilingMs: 45_000, field: { input: "60", overridden: true }, warning: null });
    expect(model.budgets.find(row => row.job === "product-search-verify")!.warning).toContain("키워드 검수 예산 여유가 15초보다 좁습니다");
    expect(model.budgets.find(row => row.job === "crawl-agent-review")).toMatchObject({ ceilingMs: 60_000, field: { input: "110" }, supervisorFloorMs: null, lane: null });
    expect(model.roles).toEqual([
      { role: "crawler", label: "프로젝트 수집", registryEnv: false }, { role: "reviewer", label: "후보 심사", registryEnv: false },
      { role: "publisher", label: "제품 발행", registryEnv: false }, { role: "text", label: "소개·사유 번역", registryEnv: true },
      { role: "maintenance", label: "생존 확인·지표 집계", registryEnv: false }]);
    // 역할 순서로 묶이고 한 역할 안은 이름 순
    const roles = model.budgets.map(row => row.role);
    expect(roles.indexOf("text")).toBeGreaterThan(roles.lastIndexOf("reviewer"));
    expect(latestRoleObservations(OBSERVATIONS).reviewer).toBeNull();
    // 적용 확인(WP-B)이 registryEnv 를 실어 오면 그것도 배지가 된다
    const apply = { savedVersion: "default", allApplied: false, attention: null, roles: [
      { role: "publisher" as const, label: "제품 발행", reportedVersion: "default", observedAt: null, state: "applied" as const, lagging: false, registryEnv: true }] };
    expect(view({ apply }).roles.find(role => role.role === "publisher")).toMatchObject({ registryEnv: true });
  });

  it("예산을 적지 않은 잡은 runner 기본으로 돈다고 알리고, 빈 문서는 모두 기본값·판 default 다", () => {
    const model = view({ row: { ...ROW, values: { version: 1 } } });
    expect(model).toMatchObject({ version: "default", shortVersion: "default" });
    expect(model.budgets.find(row => row.job === "crawl-tagline")).toMatchObject({ declared: false, field: { input: "", overridden: false, note: expect.stringContaining("runner 기본 25초") } });
    expect(model.warnings).toContain("소개 생성 은 예산을 적지 않아 runner 기본 25초로 돕니다 — 호출 상한보다 짧습니다");
    expect(model.routes.every(row => !row.timeout?.overridden && !row.maxTokens?.overridden)).toBe(true);
  });

  it("행이 없으면(0151 전·stub) 기본값으로 그리고 읽기 전용이다; 저장 문서 문제는 한국어로 올린다", () => {
    const missing = view({ row: null, rowError: "runtime_settings_not_implemented" });
    expect(missing).toMatchObject({ revision: null, rowError: "runtime_settings_not_implemented", shortVersion: "default" });
    const broken = view({ row: { ...ROW, values: { version: 1, budgets: { "product-translate": 100_000 }, routes: { timeouts: { nope: 1_000 } } } } });
    expect(broken.issues).toEqual(expect.arrayContaining(["모르는 경로입니다: nope", "공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초"]));
  });

  it("감사 줄은 바뀐 값을 한국어 이름으로 — 그룹 안 경로와 전체 경로를 모두 읽는다", () => {
    const model = view();
    expect(model.audit).toEqual([{ id: 1, actor: "jr", at: NOW.toISOString(), ok: true, group: "번역·묶음", revision: 4, changes: ["공개 번역 묶음 글자 임계: 8000 → 6000"], error: null }]);
    expect(buildRuntimeSettingsAdminView({ row: ROW, audit: [audit({ ok: false, error: "stale_form · budget_below_call_timeout:product-translate" })] }).audit[0].error)
      .toBe("그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요. · 공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초");
    expect(auditChangeLines(audit({ target: "runtime_settings:budgets", detail: { changes: [{ path: "budgets.product-translate", before: "auto", after: 320_000 }, { path: "crawl-tagline", before: null, after: 60_000 }] } })))
      .toEqual(["공개 번역 틱 예산(ms): auto → 320000", "소개 생성 틱 예산(ms): 기본값 → 60000"]);
    expect(buildRuntimeSettingsAdminView({ row: ROW, audit: Array.from({ length: 12 }, (_, index) => audit({ id: index + 1 })) }).audit).toHaveLength(10);
  });
});

describe("폼 → sparse patch", () => {
  it("바뀐 칸만 그룹 모양 문서로 보내고, ms 칸은 초를 ms 로 바꾼다", () => {
    const result = runtimeSettingsPatchFromForm("translation", form({
      "value:translation.product.batchChars": "6,000", "initial:translation.product.batchChars": "8000", "stored:translation.product.batchChars": "0",
      "value:translation.product.maxSourceChars": "30000", "initial:translation.product.maxSourceChars": "30000",
      "value:translation.product.jobMarginMs": "20.5", "initial:translation.product.jobMarginMs": "15" }));
    expect(result).toEqual({ patch: { translation: { product: { batchChars: 6_000, jobMarginMs: 20_500 } } }, changed: ["translation.product.batchChars", "translation.product.jobMarginMs"], issues: [] });
    // 같은 값을 다르게 적어도(300 ↔ 300.0) 바뀐 것이 아니다
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.limits.product-translate.timeoutMs": "300.0", "initial:routes.limits.product-translate.timeoutMs": "300" })).changed).toEqual([]);
  });

  it("「기본값으로」는 덮어쓴 키에만 null 을 넣고, 다른 그룹 경로·숫자 아닌 값·빈 값은 거절한다", () => {
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.timeouts.crawl-tagline": "45", "initial:routes.timeouts.crawl-tagline": "40",
      "reset:routes.timeouts.crawl-tagline": "on", "stored:routes.timeouts.crawl-tagline": "1" }))).toEqual({ patch: { routes: { timeouts: { "crawl-tagline": null } } }, changed: ["routes.timeouts.crawl-tagline"], issues: [] });
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.timeouts.crawl-tagline": "45", "initial:routes.timeouts.crawl-tagline": "45",
      "reset:routes.timeouts.crawl-tagline": "on", "stored:routes.timeouts.crawl-tagline": "0" })).changed).toEqual([]);
    expect(runtimeSettingsPatchFromForm("translation", form({ "value:budgets.crawl-tagline": "60" })).issues).toEqual(["모르는 설정입니다: budgets.crawl-tagline"]);
    expect(runtimeSettingsPatchFromForm("translation", form({ "value:translation.product.batchChars": "많이", "initial:translation.product.batchChars": "8000" })).issues)
      .toEqual(["공개 번역 묶음 글자 임계: 정수를 넣어주세요"]);
    expect(runtimeSettingsPatchFromForm("translation", form({ "value:translation.product.batchChars": "1.5", "initial:translation.product.batchChars": "8000" })).issues)
      .toEqual(["공개 번역 묶음 글자 임계: 정수를 넣어주세요"]);
    expect(runtimeSettingsPatchFromForm("translation", form({ "value:translation.product.jobMarginMs": "", "initial:translation.product.jobMarginMs": "15" })).issues[0]).toContain("값이 비었습니다");
    // 중계 기한은 비우면 "중계 없음"(null)
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.deadlines.review-gateway.relayMs": "", "initial:routes.deadlines.review-gateway.relayMs": "52" })).patch)
      .toEqual({ routes: { deadlines: { "review-gateway": { relayMs: null } } } });
  });

  it("처음부터 빈칸이고 손대지 않은 칸은 건너뛴다 — 같은 묶음의 다른 칸 저장을 막지 않는다(2026-11-07 CLI 심사 상한 저장 거절)", () => {
    // 코드 기본값이 없는 호출 상한 칸 다섯 개는 빈칸으로 그려지고 「기본값으로」도 없다(덮어쓴 칸에만 있음)
    const untouched = Object.fromEntries(["classify-claude", "human-review", "product-intro-check", "gateway-review", "direct-review"].flatMap(route => [
      [`value:routes.timeouts.${route}`, ""], [`initial:routes.timeouts.${route}`, ""], [`stored:routes.timeouts.${route}`, "0"]]));
    const result = runtimeSettingsPatchFromForm("routes", form({ ...untouched,
      "value:routes.limits.review-cli.timeoutMs": "60", "initial:routes.limits.review-cli.timeoutMs": "20", "stored:routes.limits.review-cli.timeoutMs": "0",
      "value:routes.limits.review-cli.maxTokens": "2000", "initial:routes.limits.review-cli.maxTokens": "2000" }));
    expect(result).toEqual({ patch: { routes: { limits: { "review-cli": { timeoutMs: 60_000 } } } }, changed: ["routes.limits.review-cli.timeoutMs"], issues: [] });
    // 아무것도 안 바꾸면 바뀐 것이 없다(거절 아님)
    expect(runtimeSettingsPatchFromForm("routes", form(untouched))).toEqual({ patch: {}, changed: [], issues: [] });
    // 값이 있던 칸을 비우는 것은 여전히 거절한다(기본값으로 돌리려면 「기본값으로」)
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.timeouts.crawl-tagline": "", "initial:routes.timeouts.crawl-tagline": "40" })).issues[0])
      .toContain("값이 비었습니다");
    // 빈칸이던 칸에 값을 넣으면 저장한다
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.timeouts.human-review": "90", "initial:routes.timeouts.human-review": "" })).patch)
      .toEqual({ routes: { timeouts: { "human-review": 90_000 } } });
  });

  it("초 칸에 ms 를 넣으면(1시간 초과) 고칠 값을 알려 주며 거절한다(2026-11-07 CLI 심사 상한 60000 입력)", () => {
    const result = runtimeSettingsPatchFromForm("routes", form({ "value:routes.limits.review-cli.timeoutMs": "60000", "initial:routes.limits.review-cli.timeoutMs": "20" }));
    expect(result.patch).toEqual({});
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("60000초는 1시간이 넘습니다");
    expect(result.issues[0]).toContain("ms로 넣으셨다면 60초");
    // 1시간까지는 그대로 받는다
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.limits.review-cli.timeoutMs": "3600", "initial:routes.limits.review-cli.timeoutMs": "20" })).patch)
      .toEqual({ routes: { limits: { "review-cli": { timeoutMs: 3_600_000 } } } });
    // 틱 예산도 같다
    expect(runtimeSettingsPatchFromForm("budgets", form({ "value:budgets.product-translate": "315000", "initial:budgets.product-translate": "315", "initialAuto:budgets.product-translate": "0" })).issues[0])
      .toContain("1시간이 넘습니다");
    // 정수 칸(토큰·동시 호출)은 단위가 없어 이 검사를 하지 않는다
    expect(runtimeSettingsPatchFromForm("routes", form({ "value:routes.limits.review-cli.maxTokens": "8000", "initial:routes.limits.review-cli.maxTokens": "2000" })).issues).toEqual([]);
  });

  it("열거 칸(3b-E) — 배정 표 읽기는 선택지의 글자 그대로, 선택지 밖·빈 값은 거절, 처음 값과 같으면 바뀐 것이 없다, 「기본값으로」는 덮어쓴 칸에만", () => {
    const toggle = (over: Record<string, string>) => runtimeSettingsPatchFromForm("assignments", form({ "value:assignments.tableReads": "off", "initial:assignments.tableReads": "off",
      "stored:assignments.tableReads": "0", ...over }));
    expect(toggle({ "value:assignments.tableReads": "on" })).toEqual({ patch: { assignments: { tableReads: "on" } }, changed: ["assignments.tableReads"], issues: [] });
    expect(toggle({}).changed).toEqual([]);
    expect(toggle({ "value:assignments.tableReads": "yes" }).issues).toEqual(["배정 표 읽기: 고를 수 있는 값이 아닙니다(yes)"]);
    expect(toggle({ "value:assignments.tableReads": "" }).issues).toEqual(["배정 표 읽기: 고를 수 있는 값이 아닙니다(비었음)"]);
    expect(toggle({ "value:assignments.tableReads": "on", "initial:assignments.tableReads": "on", "stored:assignments.tableReads": "1", "reset:assignments.tableReads": "on" }))
      .toEqual({ patch: { assignments: { tableReads: null } }, changed: ["assignments.tableReads"], issues: [] });
    // 다른 묶음의 폼에 끼운 토글 칸은 모르는 설정이다
    expect(runtimeSettingsPatchFromForm("budgets", form({ "value:assignments.tableReads": "on" })).issues).toEqual(["모르는 설정입니다: assignments.tableReads"]);
    expect(runtimeSettingsIssueMessage("runtime_settings_invalid:assignments.tableReads")).toBe("배정 표 읽기: 고를 수 있는 값이 아닙니다(off · on)");
    expect(runtimeSettingsIssueMessage("unknown_setting:assignments.extra")).toBe("모르는 설정입니다: assignments.extra");
  });

  it("예산 — auto 를 켜면 \"auto\", 끄면 초 값, 둘 다 그대로면 바뀐 것이 없다", () => {
    const budget = (over: Record<string, string>) => runtimeSettingsPatchFromForm("budgets", form({ "value:budgets.product-translate": "315", "initial:budgets.product-translate": "315", "initialAuto:budgets.product-translate": "1", ...over }));
    expect(budget({ "auto:budgets.product-translate": "on" }).changed).toEqual([]);
    expect(budget({ "value:budgets.product-translate": "320" })).toEqual({ patch: { budgets: { "product-translate": 320_000 } }, changed: ["budgets.product-translate"], issues: [] });
    expect(budget({ "value:budgets.product-translate": "" }).issues).toEqual(["공개 번역 틱 예산(초): 초 단위 숫자를 넣어주세요"]);
    expect(runtimeSettingsPatchFromForm("budgets", form({ "value:budgets.crawl-tagline": "", "initialAuto:budgets.crawl-tagline": "0", "auto:budgets.crawl-tagline": "on" })).patch)
      .toEqual({ budgets: { "crawl-tagline": "auto" } });
    expect(runtimeSettingsPatchFromForm("budgets", form({ "value:budgets.product-translate": "315", "initial:budgets.product-translate": "315", "initialAuto:budgets.product-translate": "1",
      "auto:budgets.product-translate": "on", "stored:budgets.product-translate": "1", "reset:budgets.product-translate": "on" })).patch)
      .toEqual({ budgets: { "product-translate": null } });
  });
});

describe("거절 코드 → 한국어", () => {
  it("계획서의 문장을 그대로 쓰고, 모르는 코드는 숨기지 않는다", () => {
    expect(runtimeSettingsIssueMessage("stale_form")).toBe("그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.");
    expect(runtimeSettingsIssueMessage("site_fenced")).toBe("이 사이트는 지금 쓰기가 막혀 있습니다(DR).");
    expect(runtimeSettingsIssueMessage("unknown_route:foo")).toBe("모르는 경로입니다: foo");
    expect(runtimeSettingsIssueMessage("budget_below_call_timeout:product-translate")).toBe("공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초");
    expect(runtimeSettingsIssueMessage("budget_below_min_call:crawl-tagline")).toContain("소개 생성 틱 예산이 최소 남은 시간보다 짧습니다");
    expect(runtimeSettingsIssueMessage("batch_exceeds_source_cap")).toBe("묶음 글자 수가 원문 상한보다 큽니다");
    expect(runtimeSettingsIssueMessage("deadline_order_inverted")).toBe("기한 사다리 순서가 어긋났습니다(엔진 < 중계 < 게이트웨이 < 클라이언트, 층 사이 2초 이상)");
    expect(runtimeSettingsIssueMessage("model_timeout_ladder_mismatch")).toBe("호출 상한이 같은 경로 사다리의 클라이언트 기한과 다릅니다");
    expect(runtimeSettingsIssueMessage("timeout_below_engine_bound:review-gateway")).toBe("AI 심사 호출 상한이 엔진 기한 + 2초보다 짧습니다");
    expect(runtimeSettingsIssueMessage("runtime_settings_invalid:translation.product.batchChars")).toBe("공개 번역 묶음 글자 임계: 범위를 벗어났습니다");
    expect(runtimeSettingsIssueMessage("unknown_job_knob:crawl-tagline.callMs")).toBe("소개 생성 에 없는 손잡이입니다: callMs");
    expect(runtimeSettingsIssueMessage("something_new:detail")).toBe("something_new:detail");
  });
});

describe("server action — 쓰기 관문 뒤 관리자 확인·CAS·거절 문장", () => {
  it("그룹의 sparse patch 와 expectedRevision 을 저장 경로로 넘기고 판·revision 을 알린다", async () => {
    const result = await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: "3",
      "value:translation.product.batchChars": "6000", "initial:translation.product.batchChars": "8000", "stored:translation.product.batchChars": "0",
      "value:translation.product.maxAttempts": "4", "initial:translation.product.maxAttempts": "4" }));
    expect(mocks.save).toHaveBeenCalledWith({ translation: { product: { batchChars: 6_000 } } }, "operator", { expectedRevision: 3, group: "translation" });
    expect(result).toEqual({ ok: true, message: "저장했습니다(판 vabcdef, revision 4). 각 워커는 30초 안에 다음 틱부터 씁니다." });
  });

  it("CAS 거절과 검사 거절은 그대로 한국어로 보이고 성공으로 바꾸지 않는다", async () => {
    mocks.save.mockResolvedValue({ ok: false, issues: ["stale_form", "budget_below_call_timeout:product-translate"] });
    const result = await saveRuntimeSettingsGroup(null, form({ group: "budgets", expectedRevision: "2", "value:budgets.product-translate": "100", "initial:budgets.product-translate": "315", "initialAuto:budgets.product-translate": "1" }));
    expect(result).toEqual({ issues: ["그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.", "공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초"] });
    mocks.save.mockRejectedValue(new Error("runtime_settings_not_implemented"));
    expect(await saveRuntimeSettingsGroup(null, form({ group: "budgets", expectedRevision: "2", "value:budgets.product-translate": "400", "initial:budgets.product-translate": "315", "initialAuto:budgets.product-translate": "1" })))
      .toEqual({ issues: ["저장 경로가 아직 준비되지 않았습니다(runtime_settings)."] });
  });

  it("비관리자·판 번호 없음·바뀐 것 없음·장비 묶음은 저장 경로에 닿지 않는다", async () => {
    const changed = { "value:translation.product.batchChars": "6000", "initial:translation.product.batchChars": "8000" };
    expect(await saveRuntimeSettingsGroup(null, form({ group: "translation", ...changed }))).toEqual({ issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] });
    expect(await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: "3", "value:translation.product.batchChars": "8000", "initial:translation.product.batchChars": "8000" })))
      .toEqual({ issues: ["바뀐 값이 없습니다."] });
    expect(await saveRuntimeSettingsGroup(null, form({ group: "devices", expectedRevision: "3", ...changed }))).toEqual({ issues: ["모르는 설정 묶음입니다. 새로고침해주세요."] });
    mocks.admin.mockResolvedValue(null);
    expect(await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: "3", ...changed }))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("폼 그리기", () => {
  const model = view();
  it("경로 한도 — 한국어 이름표·기본값·덮어씀·기본값으로·숨은 revision·사다리 선언 안내", () => {
    const html = renderToStaticMarkup(createElement(RoutesForm, { routes: model.routes, ladders: model.ladders, revision: model.revision }));
    expect(html).toContain('name="group" value="routes"');
    expect(html).toContain('name="expectedRevision" value="3"');
    expect(html).toContain('name="value:routes.limits.product-translate.timeoutMs"');
    expect(html).toContain('aria-label="공개 번역 호출 상한(초)"');
    expect(html).toContain('value="290"');
    expect(html).toContain("기본 300초");
    expect(html).toContain("덮어씀");
    expect(html).toContain('name="reset:routes.limits.product-translate.timeoutMs"');
    expect(html).toContain("기본값으로");
    expect(html).toContain("m1:translation");
    expect(html).toContain("이 숫자를 강제하는 게이트웨이는 없습니다");
    expect(html).toContain("모델 자체의 상한은 모델 연결 → 등록부 덮어쓰기");
    expect(html).toContain("이 묶음 저장");
    expect(html).not.toMatch(/name="value:routes\.deadlines\.review-gateway\.relayMs"[^>]*placeholder="모델 상한"/);
  });
  it("모델 배정 읽기(3b-E) — assignments 묶음 폼: select 선택지·숨은 initial/stored·기본값 글·덮어쓴 칸의 「기본값으로」·compact 는 제목 없이", () => {
    const html = renderToStaticMarkup(createElement(AssignmentsForm, { fields: model.assignments, revision: model.revision }));
    expect(html).toContain('name="group" value="assignments"');
    expect(html).toContain('name="expectedRevision" value="3"');
    expect(html).toContain('<select name="value:assignments.tableReads"');
    expect(html).toContain('aria-label="배정 표 읽기"');
    expect(html).toContain('<option value="off" selected="">끔 — 설정(legacy)으로 고른다</option>');
    expect(html).toContain('<option value="on">켬 — 배정 표(live 행)로 고른다</option>');
    expect(html).toContain('name="initial:assignments.tableReads" value="off"');
    expect(html).toContain('name="stored:assignments.tableReads" value="0"');
    expect(html).toContain("기본 끔 — 설정(legacy)으로 고른다");
    expect(html).toContain("배정 표 읽기</h3>");
    expect(html).not.toContain('name="reset:assignments.tableReads"');
    expect(html).toContain("이 묶음 저장");
    const on = view({ row: { ...ROW, values: { ...STORED, assignments: { tableReads: "on" } } } });
    const compact = renderToStaticMarkup(createElement(AssignmentsForm, { fields: on.assignments, revision: on.revision, compact: true }));
    expect(compact).toContain('<option value="on" selected="">');
    expect(compact).toContain("덮어씀");
    expect(compact).toContain('name="reset:assignments.tableReads"');
    expect(compact).not.toContain("배정 표 읽기</h3>");
    const locked = renderToStaticMarkup(createElement(AssignmentsForm, { fields: model.assignments, revision: null, readOnly: true }));
    expect(locked).toMatch(/<select name="value:assignments\.tableReads"[^>]*disabled=""/);
    expect(locked).toContain("저장 행을 읽지 못해 읽기 전용입니다.");
  });
  it("번역·묶음 — 공개 번역과 잡별 묶음은 저장 묶음이 다른 두 폼이다", () => {
    const html = renderToStaticMarkup(createElement(TranslationForm, { translation: model.translation, jobKnobs: model.jobKnobs, revision: model.revision }));
    expect(html).toContain('name="group" value="translation"');
    expect(html).toContain('name="group" value="jobs"');
    for (const label of ["공개 번역 원문 글자 상한", "공개 번역 묶음 글자 임계", "공개 번역 요청 보류 한도", "공개 번역 최대 시도", "공개 번역 틱 여유(초)"]) expect(html).toContain(label);
    expect(html).toContain("고정");
    expect(html).toContain("source_too_long");
    for (const label of ["사유 번역", "소개 생성", "한국어 소개", "검색 키워드", "키워드 검수", "소개 검수", "최소 남은 시간(초)", "혼자 보내는 실패 수"]) expect(html).toContain(label);
    expect(html).toContain('name="value:jobs.product-intro-check.callMs"');
  });
  it("틱 예산 — auto 풀이·감독 하한·지금 도는 틱·여유 경고·읽기 전용", () => {
    const html = renderToStaticMarkup(createElement(BudgetsForm, { budgets: model.budgets, revision: model.revision }));
    expect(html).toContain("= 호출 상한 290초 + 여유 15초 = 305초");
    expect(html).toContain('name="auto:budgets.product-translate"');
    expect(html).toContain("180초");
    expect(html).toContain("도는 중 12초");
    expect(html).toContain("알린 예산 315초");
    expect(html).toContain("소개·사유 번역");
    expect(html).toContain("키워드 검수 예산 여유가 15초보다 좁습니다");
    const autoInput = html.split("<input").find(part => part.includes('name="value:budgets.product-translate"'))!;
    expect(autoInput).toContain('readOnly=""');
    expect(autoInput).not.toContain("disabled");
    const secondsInput = html.split("<input").find(part => part.includes('name="value:budgets.crawl-tagline"'))!;
    expect(secondsInput).not.toContain('readOnly=""');
    const readOnly = renderToStaticMarkup(createElement(BudgetsForm, { budgets: model.budgets, revision: null, readOnly: true }));
    expect(readOnly).toContain("읽기 전용");
    expect(readOnly).toMatch(/<button[^>]*disabled/);
    expect(readOnly.split("<input").find(part => part.includes('name="value:budgets.product-translate"'))).toContain('disabled=""');
  });
  it("읽은 판 줄에 역할별 env 등록부 배지를 단다", () => {
    const apply = { savedVersion: "abcdef1234567890", allApplied: false, attention: null, roles: [
      { role: "text" as const, label: "소개·사유 번역", reportedVersion: "abcdef1234567890", observedAt: NOW.getTime() - 60_000, state: "applied" as const, lagging: false },
      { role: "crawler" as const, label: "프로젝트 수집", reportedVersion: "default", observedAt: NOW.getTime() - 60_000, state: "waiting" as const, lagging: false }] };
    const html = renderToStaticMarkup(createElement(SettingsApplyLine, { apply, now: NOW, badges: { text: { label: "env 등록부", title: "env" } } }));
    expect(html).toContain("env 등록부");
    expect(html.match(/env 등록부/g)).toHaveLength(1);
    expect(html).toContain("vabcdef");
  });
});

describe("pipeline-control status 의 실시간 한도 줄", () => {
  it("판·revision·source 와 env 등록부 여부를 한 줄로 낸다", () => {
    const snapshot = { version: "abcdef1234567890", revision: 4, loadedAt: NOW.getTime(), source: "db" as const, settings: view().effective };
    const readback = runtimeSettingsReadback(snapshot, { MODEL_REGISTRY_CONFIG: "" });
    expect(readback).toEqual({ version: "abcdef1234567890", shortVersion: "vabcdef", revision: 4, source: "db", loadedAt: NOW.toISOString(), registryEnv: false });
    expect(formatRuntimeSettingsLine(readback)).toBe("[runtime-settings] 판=vabcdef revision=4 source=db");
    expect(formatRuntimeSettingsLine(runtimeSettingsReadback({ ...snapshot, version: "default", revision: null, loadedAt: 0, source: "default" }, { MODEL_REGISTRY_CONFIG: "{}" })))
      .toBe("[runtime-settings] 판=default revision=- source=default 경로 한도=MODEL_REGISTRY_CONFIG env(저장이 이 프로세스에 닿지 않음)");
  });
});

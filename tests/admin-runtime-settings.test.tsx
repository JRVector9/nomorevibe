import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 실시간 한도의 칸·폼 → sparse patch·거절 문장·server action, 그리고 다른 화면으로 옮긴 칸 묶음(2026-11-11 개편). DB 없이 본다; 저장 본문은 가짜다.
// 「실시간 한도」 화면의 작업 줄 모형·규칙·편집기는 tests/admin-limits-view.test.tsx 가 본다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), readRow: vi.fn(), readApply: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/runtime-settings", async importOriginal => ({ ...(await importOriginal<object>()),
  saveRuntimeSettings: mocks.save, readRuntimeSettingsRow: mocks.readRow, readRuntimeSettingsApply: mocks.readApply }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import { saveRuntimeLimits, saveRuntimeSettingsGroup } from "@/app/(operator)/admin/models/limits/actions";
import { SettingsApplyLine } from "@/app/(operator)/admin/settings/SettingsApplyLine";
import { AssignmentsForm } from "@/app/(operator)/admin/models/limits/AssignmentsForm";
import { CapacityForm } from "@/app/(operator)/admin/models/limits/CapacityForm";
import { SettingsFieldsForm } from "@/app/(operator)/admin/models/limits/SettingsFieldsForm";
import { LimitsEditor } from "@/app/(operator)/admin/models/limits/LimitsEditor";
import { buildLimitsView } from "@/lib/operations/admin-limits-view";
import { auditChangeLines, auditView, buildAssignmentReadsControl, buildSettingsControl, fieldLabel, JOB_CONCURRENCY_CONTROL, latestRoleObservations, LIMITS_PAGE_GROUPS,
  readSettingsControl, runtimeSettingsIssueMessage, runtimeSettingsPatchFromForm, TRANSLATION_LIMITS_CONTROL, UNKNOWN_HOLD_CONTROL, type AdminObservation } from "@/lib/operations/admin-runtime-settings";
import type { AdminLogRow } from "@/lib/operations/admin-log";
import { formatRuntimeSettingsLine, runtimeSettingsReadback } from "@/lib/operations/pipeline-control-status";
import { resolveRuntimeSettings, RUNTIME_SETTING_LABELS, type RuntimeSettingGroup } from "@/lib/operations/runtime-settings-schema";

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
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };

beforeEach(() => {
  mocks.admin.mockReset().mockResolvedValue({ login: "operator" });
  mocks.save.mockReset().mockResolvedValue({ ok: true, revision: 4, version: "abcdef1234567890" });
  mocks.revalidate.mockReset();
});

describe("칸 모형·옮긴 칸 묶음 — 유효값·기본값·덮어씀", () => {
  it("모델 배정 읽기(3b-E) — 열거 칸 하나: 기본 off, 저장 문서가 on 이면 덮어씀, 선택지와 안내가 붙는다; 배정 화면용 묶음은 행 하나로 만든다", () => {
    const [toggle] = buildAssignmentReadsControl(ROW).fields;
    expect(toggle).toMatchObject({ path: "assignments.tableReads", label: "배정 표 읽기", kind: "choice", value: "off", defaultValue: "off", input: "off", defaultInput: "off",
      overridden: false, options: [{ value: "off", label: "끔 — 설정(legacy)으로 고른다" }, { value: "on", label: "켬 — 배정 표(live 행)로 고른다" }] });
    expect(toggle.note).toContain("재배포 없음");
    expect(toggle.note).toContain("MODEL_ASSIGNMENT_TABLE");
    expect(fieldLabel("assignments.tableReads")).toBe("배정 표 읽기");
    const control = buildAssignmentReadsControl({ ...ROW, values: { ...STORED, assignments: { tableReads: "on" } } });
    expect(control).toMatchObject({ revision: 3, rowError: null, fields: [{ path: "assignments.tableReads", input: "on", overridden: true }] });
    expect(buildAssignmentReadsControl(null, "runtime_settings_row_missing")).toMatchObject({ revision: null, rowError: "runtime_settings_row_missing", fields: [{ input: "off", overridden: false }] });
  });

  it("결과 미확정 점유(장비 한도 화면으로 옮김) — 초 정수 칸 하나: 기본 600, 저장 문서가 0 이면 덮어씀, 폼은 정수 그대로 sparse patch", () => {
    const [hold] = buildSettingsControl(ROW, UNKNOWN_HOLD_CONTROL).fields;
    expect(hold).toMatchObject({ path: "capacity.unknownHoldSeconds", label: "결과 미확정 점유 유지(초)", kind: "int", value: 600, defaultValue: 600,
      input: "600", defaultInput: "600", overridden: false });
    expect(hold.note).toContain("0 이면 차지하지 않습니다");
    expect(hold.note).toContain("저장 즉시 다음 모델 입장부터");
    expect(buildSettingsControl({ ...ROW, values: { ...STORED, capacity: { unknownHoldSeconds: 0 } } }, UNKNOWN_HOLD_CONTROL).fields[0])
      .toMatchObject({ value: 0, input: "0", overridden: true });
    const patch = (over: Record<string, string>) => runtimeSettingsPatchFromForm("capacity", form({ "value:capacity.unknownHoldSeconds": "600",
      "initial:capacity.unknownHoldSeconds": "600", "stored:capacity.unknownHoldSeconds": "0", ...over }));
    expect(patch({ "value:capacity.unknownHoldSeconds": "300" })).toEqual({ patch: { capacity: { unknownHoldSeconds: 300 } }, changed: ["capacity.unknownHoldSeconds"], issues: [] });
    expect(patch({ "value:capacity.unknownHoldSeconds": "0" }).patch).toEqual({ capacity: { unknownHoldSeconds: 0 } });
    expect(patch({ "value:capacity.unknownHoldSeconds": "1.5" }).issues).toEqual(["결과 미확정 점유 유지(초): 정수를 넣어주세요"]);
    expect(runtimeSettingsIssueMessage("runtime_settings_invalid:capacity.unknownHoldSeconds")).toBe("결과 미확정 점유 유지(초): 범위를 벗어났습니다(0~3600)");
  });

  it("공개 번역 한도(공개 번역 화면으로 옮김) — 네 칸 + 묶음 최대 건수(고정); 최대 시도는 4회까지만 보낸다고 알린다", () => {
    const control = buildSettingsControl(ROW, TRANSLATION_LIMITS_CONTROL);
    expect(control.fields.map(field => field.path)).toEqual(["translation.product.maxSourceChars", "translation.product.batchChars", "translation.product.demandLimit",
      "translation.product.maxAttempts", "translation.product.batchMax"]);
    expect(control.fields[1]).toMatchObject({ value: 6_000, defaultValue: 8_000, overridden: true, input: "6000", defaultInput: "8000", kind: "int",
      label: RUNTIME_SETTING_LABELS["translation.product.batchChars"] });
    expect(control.fields[0].note).toContain("source_too_long");
    expect(control.fields[3].note).toContain("4보다 크게 해도 더 보내지 않습니다");
    expect(control.fields[4]).toMatchObject({ readOnly: true, input: "4" });
    // 자동 틱 여유는 실시간 한도 화면에 남는다
    expect(control.fields.some(field => field.path === "translation.product.jobMarginMs")).toBe(false);
  });

  it("작업 배정 화면으로 옮긴 동시 업무 두 칸 — 저장 문서 값(2)과 기본(1)", () => {
    const control = buildSettingsControl({ ...ROW, values: { ...STORED, jobs: { "second-review": { consumerConcurrency: 2 } } } }, JOB_CONCURRENCY_CONTROL);
    expect(control.fields).toMatchObject([{ path: "jobs.second-review.consumerConcurrency", input: "2", defaultInput: "1", overridden: true },
      { path: "jobs.crawl-publish.classifierConcurrency", input: "1", overridden: false }]);
  });

  it("행을 못 읽으면 읽기 전용(revision null)·기본값이고, 읽기 함수는 던지지 않는다", async () => {
    expect(buildSettingsControl(null, UNKNOWN_HOLD_CONTROL, "boom")).toMatchObject({ revision: null, rowError: "boom", fields: [{ input: "600" }] });
    mocks.readRow.mockRejectedValueOnce(new Error("runtime_settings_row_missing"));
    expect(await readSettingsControl(JOB_CONCURRENCY_CONTROL)).toMatchObject({ revision: null, rowError: "runtime_settings_row_missing" });
    mocks.readRow.mockResolvedValueOnce(ROW);
    expect(await readSettingsControl(TRANSLATION_LIMITS_CONTROL)).toMatchObject({ revision: 3, rowError: null });
  });

  it("역할 관측 — 1분 넘은 관측·consumer 관측은 그 역할의 지금 상태가 아니다", () => {
    const roles = latestRoleObservations(OBSERVATIONS);
    expect(roles.text).toMatchObject({ registryEnv: true, jobMs: 180_000 });
    expect(roles.crawler).toMatchObject({ registryEnv: false, jobMs: 120_000 });
    expect(roles.reviewer).toBeNull();
  });

  it("감사 줄은 바뀐 값을 한국어 이름으로 — 그룹 안 경로와 전체 경로를 모두 읽는다", () => {
    expect(auditView([audit({})])).toEqual([{ id: 1, actor: "jr", at: NOW.toISOString(), ok: true, group: "번역·묶음", revision: 4, changes: ["공개 번역 묶음 글자 임계: 8000 → 6000"], error: null }]);
    expect(auditView([audit({ ok: false, error: "stale_form · budget_below_call_timeout:product-translate" })])[0].error)
      .toBe("그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요. · 공개 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초");
    expect(auditChangeLines(audit({ target: "runtime_settings:budgets", detail: { changes: [{ path: "budgets.product-translate", before: "auto", after: 320_000 }, { path: "crawl-tagline", before: null, after: 60_000 }] } })))
      .toEqual(["공개 번역 틱 예산(ms): auto → 320000", "소개 생성 틱 예산(ms): 기본값 → 60000"]);
    expect(auditView(Array.from({ length: 12 }, (_, index) => audit({ id: index + 1 })))).toHaveLength(10);
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

  // 그려진 폼을 브라우저가 보내는 그대로 모은다 — 폼마다(숨은 group 칸으로 가름, 없으면 「실시간 한도」 한 폼) 이름 있는 칸, disabled 제외, 체크박스는 켜진 것만, select 는 고른 option
  const submittedForms = (html: string) => {
    const decode = (value: string) => value.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const attr = (tag: string, name: string) => { const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return match ? decode(match[1]) : null; };
    const forms = new Map<string, FormData>();
    for (const part of html.split("<form").slice(1)) {
      const body = part.slice(0, part.indexOf("</form>")), data = new FormData();
      for (const [tag] of body.matchAll(/<input[^>]*>/g)) {
        const name = attr(tag, "name");
        if (!name || /\sdisabled=""/.test(tag) || (attr(tag, "type") === "checkbox" && !/\schecked=""/.test(tag))) continue;
        data.append(name, attr(tag, "value") ?? (attr(tag, "type") === "checkbox" ? "on" : ""));
      }
      for (const [, open, options] of body.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
        const name = attr(open, "name");
        if (!name || /\sdisabled=""/.test(open)) continue;
        const chosen = /<option[^>]*\sselected=""[^>]*>/.exec(options)?.[0] ?? /<option[^>]*>/.exec(options)?.[0] ?? "";
        data.append(name, attr(chosen, "value") ?? "");
      }
      // 「실시간 한도」 화면은 숨은 group 칸이 없는 한 폼이다(그룹 여럿을 함께 보낸다)
      forms.set(data.has("group") ? String(data.get("group")) : "limits", data);
    }
    return forms;
  };

  it("그려진 틱 시간 칸 그대로 — 예산을 적지 않은 소개 생성이 있어도 손댄 칸만 저장한다(2026-11-11 틱 예산 저장이 늘 거절됨, 새 화면으로 옮김)", () => {
    // 운영 행처럼 예산을 덮어쓰지 않은 문서 — 소개 생성(crawl-tagline)은 예산이 없다. 새 화면은 빈칸 대신 실제로 도는 25초를 그린다
    const limits = (values: unknown) => submittedForms(renderToStaticMarkup(createElement(LimitsEditor, { view: buildLimitsView({ row: { ...ROW, values }, now: NOW }) })))
      .get("limits")!;
    const edit = (change: (data: FormData) => void, values: unknown = { version: 1 }) => { const data = limits(values); change(data); return runtimeSettingsPatchFromForm(LIMITS_PAGE_GROUPS, data); };
    expect(limits({ version: 1 }).get("value:budgets.crawl-tagline")).toBe("25");
    expect(limits({ version: 1 }).get("auto:budgets.product-translate")).toBe("on");
    // 아무것도 안 바꾸면 거절도 바뀐 것도 없다
    expect(edit(() => {})).toEqual({ patch: {}, changed: [], issues: [] });
    // 다른 잡 하나만 고치면 그 칸만 저장한다
    expect(edit(data => data.set("value:budgets.product-search-profile", "60")))
      .toEqual({ patch: { budgets: { "product-search-profile": 60_000 } }, changed: ["budgets.product-search-profile"], issues: [] });
    // 소개 생성에 값을 넣으면 저장한다
    expect(edit(data => data.set("value:budgets.crawl-tagline", "50")))
      .toEqual({ patch: { budgets: { "crawl-tagline": 50_000 } }, changed: ["budgets.crawl-tagline"], issues: [] });
    // auto 켜기 — "auto"
    expect(edit(data => data.set("auto:budgets.crawl-tagline", "on"))).toEqual({ patch: { budgets: { "crawl-tagline": "auto" } }, changed: ["budgets.crawl-tagline"], issues: [] });
    // auto 끄기 — 글자를 그대로 두면 지금 auto 값(315초)을 숫자로 저장한다
    expect(edit(data => data.delete("auto:budgets.product-translate")))
      .toEqual({ patch: { budgets: { "product-translate": 315_000 } }, changed: ["budgets.product-translate"], issues: [] });
    // 손댄 칸의 잘못된 값은 여전히 같은 문장으로 거절한다
    expect(edit(data => data.set("value:budgets.crawl-tagline", "많이"))).toEqual({ patch: {}, changed: [], issues: ["소개 생성 틱 예산(초): 초 단위 숫자를 넣어주세요"] });
    expect(edit(data => data.set("value:budgets.product-search-profile", ""))).toEqual({ patch: {}, changed: [],
      issues: [`${fieldLabel("budgets.product-search-profile")}: 초 단위 숫자를 넣어주세요`] });
    // 덮어쓴 예산의 「기본값으로」 — 저장 문서에서 키를 지운다(null)
    expect(edit(() => {}, STORED)).toEqual({ patch: {}, changed: [], issues: [] });
    expect(edit(data => data.set("reset:budgets.crawl-tagline", "on"), STORED))
      .toEqual({ patch: { budgets: { "crawl-tagline": null } }, changed: ["budgets.crawl-tagline"], issues: [] });
  });

  it("다른 폼도 그려진 그대로 보내면 거절도 바뀐 것도 없다 — 실시간 한도 한 폼과 옮긴 칸의 그룹 폼들", () => {
    for (const row of [{ ...ROW, values: { version: 1 } }, ROW]) {
      const html = [createElement(LimitsEditor, { view: buildLimitsView({ row, now: NOW }) }),
        createElement(SettingsFieldsForm, { group: "translation", fields: buildSettingsControl(row, TRANSLATION_LIMITS_CONTROL).fields, revision: 3 }),
        createElement(SettingsFieldsForm, { group: "jobs", fields: buildSettingsControl(row, JOB_CONCURRENCY_CONTROL).fields, revision: 3 }),
        createElement(AssignmentsForm, { fields: buildAssignmentReadsControl(row).fields, revision: 3 }),
        createElement(CapacityForm, { fields: buildSettingsControl(row, UNKNOWN_HOLD_CONTROL).fields, revision: 3 })].map(element => renderToStaticMarkup(element)).join("");
      const forms = submittedForms(html);
      expect([...forms.keys()].sort()).toEqual(["assignments", "capacity", "jobs", "limits", "translation"]);
      for (const [group, data] of forms) expect(runtimeSettingsPatchFromForm(group === "limits" ? LIMITS_PAGE_GROUPS : group as RuntimeSettingGroup, data), group)
        .toEqual({ patch: {}, changed: [], issues: [] });
    }
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
    // 모델 장부 점유는 입장 TX 가 행을 바로 읽는다 — 30초 스냅숏 문구를 쓰지 않는다
    const capacity = await saveRuntimeSettingsGroup(null, form({ group: "capacity", expectedRevision: "4",
      "value:capacity.unknownHoldSeconds": "300", "initial:capacity.unknownHoldSeconds": "600", "stored:capacity.unknownHoldSeconds": "0" }));
    expect(mocks.save).toHaveBeenLastCalledWith({ capacity: { unknownHoldSeconds: 300 } }, "operator", { expectedRevision: 4, group: "capacity" });
    expect(capacity).toEqual({ ok: true, message: "저장했습니다(판 vabcdef, revision 4). 다음 모델 입장부터 씁니다." });
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

describe("server action — 실시간 한도 화면 한 폼(saveRuntimeLimits)", () => {
  it("바뀐 칸의 그룹만 골라 한 번에 저장한다(그룹 여럿이면 배열, 하나면 그 그룹) — 다른 화면도 다시 그린다", async () => {
    const changed = { expectedRevision: "9", "value:routes.limits.product-translate.timeoutMs": "100", "initial:routes.limits.product-translate.timeoutMs": "120",
      "value:budgets.product-translate": "115", "initial:budgets.product-translate": "135", "initialAuto:budgets.product-translate": "1" };
    const result = await saveRuntimeLimits(null, form(changed));
    expect(mocks.save).toHaveBeenCalledWith({ routes: { limits: { "product-translate": { timeoutMs: 100_000 } } }, budgets: { "product-translate": 115_000 } }, "operator",
      { expectedRevision: 9, group: ["routes", "budgets"] });
    expect(result).toEqual({ ok: true, message: "저장했습니다 — 바뀐 값 2개(판 vabcdef, revision 4). 각 워커는 30초 안에 다음 틱부터 씁니다." });
    expect(mocks.revalidate.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/admin/models/limits", "/admin/models/devices", "/admin/models/tasks", "/admin/translations"]));
    await saveRuntimeLimits(null, form({ expectedRevision: "9", "value:jobs.reason-translate.batch": "6", "initial:jobs.reason-translate.batch": "4" }));
    expect(mocks.save).toHaveBeenLastCalledWith({ jobs: { "reason-translate": { batch: 6 } } }, "operator", { expectedRevision: 9, group: "jobs" });
  });

  it("거절·바뀐 것 없음·판 번호 없음·비관리자·화면 밖 그룹은 그대로 알린다", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, issues: ["budget_below_call_timeout:reason-translate"] });
    expect(await saveRuntimeLimits(null, form({ expectedRevision: "9", "value:routes.limits.reason-translate.timeoutMs": "60", "initial:routes.limits.reason-translate.timeoutMs": "45" })))
      .toEqual({ issues: ["사유 번역 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초"] });
    expect(await saveRuntimeLimits(null, form({ expectedRevision: "9", "value:jobs.reason-translate.batch": "4", "initial:jobs.reason-translate.batch": "4" })))
      .toEqual({ issues: ["바뀐 값이 없습니다."] });
    expect(await saveRuntimeLimits(null, form({ "value:jobs.reason-translate.batch": "6", "initial:jobs.reason-translate.batch": "4" })))
      .toEqual({ issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] });
    expect(await saveRuntimeLimits(null, form({ expectedRevision: "9", "value:capacity.unknownHoldSeconds": "0", "initial:capacity.unknownHoldSeconds": "600" })))
      .toEqual({ issues: ["모르는 설정입니다: capacity.unknownHoldSeconds"] });
    mocks.admin.mockResolvedValue(null);
    expect(await saveRuntimeLimits(null, form({ expectedRevision: "9" }))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

describe("옮긴 칸의 폼 그리기", () => {
  it("모델 배정 읽기(3b-E) — assignments 묶음 폼: select 선택지·숨은 initial/stored·기본값 글·덮어쓴 칸의 「기본값으로」·compact 는 제목 없이", () => {
    const fields = buildAssignmentReadsControl(ROW).fields;
    const html = renderToStaticMarkup(createElement(AssignmentsForm, { fields, revision: 3 }));
    expect(html).toContain('name="group" value="assignments"');
    expect(html).toContain('name="expectedRevision" value="3"');
    expect(html).toContain('<select name="value:assignments.tableReads"');
    expect(html).toContain('<option value="off" selected="">끔 — 설정(legacy)으로 고른다</option>');
    expect(html).toContain('name="initial:assignments.tableReads" value="off"');
    expect(html).toContain('name="stored:assignments.tableReads" value="0"');
    expect(html).toContain("배정 표 읽기</h3>");
    expect(html).not.toContain('name="reset:assignments.tableReads"');
    const on = buildAssignmentReadsControl({ ...ROW, values: { ...STORED, assignments: { tableReads: "on" } } }).fields;
    const compact = renderToStaticMarkup(createElement(AssignmentsForm, { fields: on, revision: 3, compact: true }));
    expect(compact).toContain('<option value="on" selected="">');
    expect(compact).toContain('name="reset:assignments.tableReads"');
    expect(compact).not.toContain("배정 표 읽기</h3>");
    const locked = renderToStaticMarkup(createElement(AssignmentsForm, { fields, revision: null, readOnly: true }));
    expect(locked).toMatch(/<select name="value:assignments\.tableReads"[^>]*disabled=""/);
    expect(locked).toContain("저장 행을 읽지 못해 읽기 전용입니다.");
  });
  it("결과 미확정 점유 — capacity 묶음 폼: 초 단위 정수 칸·기본값 글", () => {
    const html = renderToStaticMarkup(createElement(CapacityForm, { fields: buildSettingsControl(ROW, UNKNOWN_HOLD_CONTROL).fields, revision: 3 }));
    expect(html).toContain('name="group" value="capacity"');
    expect(html).toContain('name="value:capacity.unknownHoldSeconds"');
    expect(html).toContain('aria-label="결과 미확정 점유 유지(초)"');
    expect(html).toContain("기본 600초");
    expect(html).toContain("이 묶음 저장");
  });
  it("공개 번역 한도·동시 업무 — 그룹 하나의 폼, 단위와 고정 칸, 그려진 그대로 보내면 바뀐 것이 없다", () => {
    const control = buildSettingsControl(ROW, TRANSLATION_LIMITS_CONTROL);
    const html = renderToStaticMarkup(createElement(SettingsFieldsForm, { group: "translation", fields: control.fields, revision: 3,
      units: { "translation.product.maxSourceChars": "자", "translation.product.maxAttempts": "회" } }));
    expect(html).toContain('name="group" value="translation"');
    expect(html).toContain('name="value:translation.product.batchChars"');
    expect(html).not.toContain('name="value:translation.product.batchMax"');
    expect(html).toContain("고정");
    expect(html).toContain("기본 4회");
    const data = new FormData();
    for (const match of html.matchAll(/<input([^>]*)>/g)) {
      const name = /name="([^"]+)"/.exec(match[1])?.[1], value = /value="([^"]*)"/.exec(match[1])?.[1] ?? "";
      if (name && !/type="checkbox"/.test(match[1])) data.append(name, value);
    }
    expect(runtimeSettingsPatchFromForm("translation", data)).toEqual({ patch: {}, changed: [], issues: [] });
    const jobs = renderToStaticMarkup(createElement(SettingsFieldsForm, { group: "jobs", fields: buildSettingsControl(ROW, JOB_CONCURRENCY_CONTROL).fields, revision: 3 }));
    expect(jobs).toContain('name="value:jobs.second-review.consumerConcurrency"');
    expect(jobs).toContain('name="value:jobs.crawl-publish.classifierConcurrency"');
  });
  it("읽은 판 줄(크롤 설정 화면이 함께 쓴다)에 역할별 env 등록부 배지를 단다", () => {
    const apply = { savedVersion: "abcdef1234567890", allApplied: false, attention: null, roles: [
      { role: "text" as const, label: "소개·사유 번역", reportedVersion: "abcdef1234567890", observedAt: NOW.getTime() - 60_000, state: "applied" as const, lagging: false },
      { role: "crawler" as const, label: "프로젝트 수집", reportedVersion: "default", observedAt: NOW.getTime() - 60_000, state: "waiting" as const, lagging: false }] };
    const html = renderToStaticMarkup(createElement(SettingsApplyLine, { apply, now: NOW, badges: { text: { label: "env 등록부", title: "env" } } }));
    expect(html.match(/env 등록부/g)).toHaveLength(1);
    expect(html).toContain("vabcdef");
  });
});

describe("pipeline-control status 의 실시간 한도 줄", () => {
  it("판·revision·source 와 env 등록부 여부를 한 줄로 낸다", () => {
    const snapshot = { version: "abcdef1234567890", revision: 4, loadedAt: NOW.getTime(), source: "db" as const, settings: resolveRuntimeSettings(STORED).settings };
    const readback = runtimeSettingsReadback(snapshot, { MODEL_REGISTRY_CONFIG: "" });
    expect(readback).toEqual({ version: "abcdef1234567890", shortVersion: "vabcdef", revision: 4, source: "db", loadedAt: NOW.toISOString(), registryEnv: false });
    expect(formatRuntimeSettingsLine(readback)).toBe("[runtime-settings] 판=vabcdef revision=4 source=db");
    expect(formatRuntimeSettingsLine(runtimeSettingsReadback({ ...snapshot, version: "default", revision: null, loadedAt: 0, source: "default" }, { MODEL_REGISTRY_CONFIG: "{}" })))
      .toBe("[runtime-settings] 판=default revision=- source=default 경로 한도=MODEL_REGISTRY_CONFIG env(저장이 이 프로세스에 닿지 않음)");
  });
});

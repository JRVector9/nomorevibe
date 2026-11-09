import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 공개분 변경 재판정 한도를 /admin/audit?tab=recheck 에서 바로 고치기(2026-11-09 운영자 요청) — 화면 모형(단위·스키마 범위·덮어씀)·server action
 * (실시간 한도와 같은 saveRuntimeSettings, group jobs·expectedRevision CAS, 다섯 칸 밖 거절)·그리기(읽기 전용)와, 실시간 한도 화면의 잡별 묶음 폼에서
 * 재판정 칸만 바꿔도 저장되는지(빈 기본 칸 거절 버그)를 DB 없이 본다. 저장 본문(saveRuntimeSettings)은 가짜다.
 */
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/runtime-settings", async importOriginal => ({ ...(await importOriginal<object>()), saveRuntimeSettings: mocks.save }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import { saveRecheckLimits } from "@/app/(operator)/admin/audit/actions";
import { RecheckLimitsForm } from "@/app/(operator)/admin/audit/RecheckLimitsForm";
import { TranslationForm } from "@/app/(operator)/admin/models/limits/TranslationForm";
import { buildRecheckLimitsControl, buildRuntimeSettingsAdminView, jobKnobRange, runtimeSettingsIssueMessage, runtimeSettingsPatchFromForm }
  from "@/lib/operations/admin-runtime-settings";
import { recheckLimits } from "@/lib/crawl/published-recheck";

const NOW = new Date("2026-11-09T12:00:00.000Z");
/** 운영의 지금 행(2026-11-09 revision 6) — 다섯 값이 모두 저장돼 있고 yieldHours 만 기본값(6)과 다르다 */
const ROW = { values: { version: 1, jobs: { "published-recheck": { scanBatch: 200, dailyCap: 100, askBatch: 2, minSimilarity: 60, yieldHours: 1 } } },
  revision: 6, updatedBy: "jr", updatedAt: "2026-11-09T11:50:00.000Z" };
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.append(key, value); return data; };
const P = "jobs.published-recheck";

beforeEach(() => {
  mocks.admin.mockReset().mockResolvedValue({ login: "operator" });
  mocks.save.mockReset().mockResolvedValue({ ok: true, revision: 7, version: "abcdef1234567890" });
  mocks.revalidate.mockReset();
});

describe("화면 모형 — 다섯 칸·단위·스키마 범위", () => {
  it("저장 행을 바로 읽어 다섯 칸을 만든다 — 단위(건·%·시간)·범위(jobKnobsSchema 그대로)·덮어씀, 화면의 다른 글도 같은 값(recheckLimits)", () => {
    const control = buildRecheckLimitsControl(ROW);
    expect(control).toMatchObject({ revision: 6, rowError: null });
    expect(control.fields.map(field => [field.knob, field.input, field.defaultInput, field.overridden, field.unit, field.min, field.max])).toEqual([
      ["scanBatch", "200", "200", true, "건", 10, 2_000], ["dailyCap", "100", "100", true, "건", 0, 5_000], ["askBatch", "2", "2", true, "건", 0, 16],
      ["minSimilarity", "60", "60", true, "%", 0, 100], ["yieldHours", "1", "6", true, "시간", 0, 168]]);
    expect(control.fields[4]).toMatchObject({ path: `${P}.yieldHours`, kind: "int", label: expect.stringContaining("1차 양보 상한(시간)") });
    expect(recheckLimits(control.settings)).toEqual({ scanBatch: 200, dailyCap: 100, askBatch: 2, minSimilarity: 0.6, yieldHours: 1 });
    // 행을 못 읽으면 기본값·읽기 전용(revision null)
    expect(buildRecheckLimitsControl(null, "runtime_settings_row_missing")).toMatchObject({ revision: null, rowError: "runtime_settings_row_missing",
      fields: [{ input: "200", overridden: false }, {}, {}, {}, { input: "6", overridden: false }] });
    expect(jobKnobRange("yieldHours")).toEqual({ min: 0, max: 168 });
    expect(jobKnobRange("nope")).toBeNull();
  });

  it("범위 밖 거절 문장은 그 칸의 스키마 범위를 말한다(잡별 정수 칸)", () => {
    expect(runtimeSettingsIssueMessage(`runtime_settings_invalid:${P}.minSimilarity`)).toBe("공개분 변경 재판정 같다고 볼 유사도(%): 범위를 벗어났습니다(0~100)");
    expect(runtimeSettingsIssueMessage(`runtime_settings_invalid:${P}.yieldHours`)).toContain("범위를 벗어났습니다(0~168)");
    // 다른 묶음은 예전 그대로
    expect(runtimeSettingsIssueMessage("runtime_settings_invalid:translation.product.batchChars")).toBe("공개 번역 묶음 글자 임계: 범위를 벗어났습니다");
  });
});

describe("server action — 실시간 한도와 같은 저장, 다섯 칸만", () => {
  const cell = (knob: string, value: string, initial: string, unit: string) => ({ expectedRevision: "6", [`value:${P}.${knob}`]: value,
    [`initial:${P}.${knob}`]: initial, [`stored:${P}.${knob}`]: "1", [`unit:${P}.${knob}`]: unit });

  it("바뀐 칸만 group jobs·expectedRevision 으로 저장하고, 바뀐 값·revision 을 알린 뒤 이 화면·실시간 한도 화면을 다시 그린다", async () => {
    const result = await saveRecheckLimits(null, form(cell("yieldHours", "3", "1", "시간")));
    expect(mocks.save).toHaveBeenCalledWith({ jobs: { "published-recheck": { yieldHours: 3 } } }, "operator", { expectedRevision: 6, group: "jobs" });
    expect(result).toEqual({ ok: true, revision: 7,
      message: "저장했습니다 — 공개분 변경 재판정 1차 양보 상한(시간) 1시간 → 3시간 (revision 7). 각 워커는 30초 안에 다음 틱부터 씁니다." });
    expect(mocks.revalidate.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/admin/audit", "/admin/models/limits"]));
    // 「기본값으로」(덮어쓴 칸)는 null 로 보낸다
    await saveRecheckLimits(null, form({ ...cell("minSimilarity", "60", "60", "%"), [`reset:${P}.minSimilarity`]: "on" }));
    expect(mocks.save).toHaveBeenLastCalledWith({ jobs: { "published-recheck": { minSimilarity: null } } }, "operator", { expectedRevision: 6, group: "jobs" });
  });

  it("범위 밖·CAS 거절은 그 자리에서 한국어로 보이고, 숫자가 아님·다섯 칸 밖·바뀐 것 없음·판 번호 없음·비관리자는 저장에 닿지 않는다", async () => {
    mocks.save.mockResolvedValue({ ok: false, issues: [`runtime_settings_invalid:${P}.minSimilarity`] });
    expect(await saveRecheckLimits(null, form(cell("minSimilarity", "150", "60", "%"))))
      .toEqual({ issues: ["공개분 변경 재판정 같다고 볼 유사도(%): 범위를 벗어났습니다(0~100)"] });
    mocks.save.mockResolvedValue({ ok: false, issues: ["stale_form"] });
    expect((await saveRecheckLimits(null, form(cell("dailyCap", "50", "100", "건"))))?.issues?.[0]).toContain("그 사이 다른 곳에서 설정이 바뀌었습니다");
    mocks.save.mockClear();
    expect(await saveRecheckLimits(null, form(cell("askBatch", "1.5", "2", "건")))).toEqual({ issues: [expect.stringContaining("정수를 넣어주세요")] });
    expect(await saveRecheckLimits(null, form({ ...cell("askBatch", "3", "2", "건"), "value:jobs.crawl-tagline.batch": "9", "initial:jobs.crawl-tagline.batch": "4" })))
      .toEqual({ issues: ["재판정 한도가 아닌 칸입니다: jobs.crawl-tagline.batch"] });
    expect(await saveRecheckLimits(null, form(cell("askBatch", "2", "2", "건")))).toEqual({ issues: ["바뀐 값이 없습니다."] });
    expect(await saveRecheckLimits(null, form({ ...cell("askBatch", "3", "2", "건"), expectedRevision: "" })))
      .toEqual({ issues: ["판 번호(revision)를 읽지 못했습니다. 새로고침해주세요."] });
    mocks.admin.mockResolvedValue(null);
    expect(await saveRecheckLimits(null, form(cell("askBatch", "3", "2", "건")))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("그리기", () => {
  it("칸마다 입력·단위·범위·저장 단추와 숨은 revision — 읽기 전용(행 못 읽음·미리보기)이면 칸과 단추가 꺼진다", () => {
    const control = buildRecheckLimitsControl(ROW);
    const html = renderToStaticMarkup(createElement(RecheckLimitsForm, { fields: control.fields, revision: 6, readOnly: false, readOnlyReason: null }));
    expect(html.match(/<form/g)).toHaveLength(5);
    expect(html.match(/name="expectedRevision" value="6"/g)).toHaveLength(5);
    for (const knob of ["scanBatch", "dailyCap", "askBatch", "minSimilarity", "yieldHours"]) expect(html).toContain(`name="value:${P}.${knob}"`);
    expect(html).toContain("범위 0~100%");
    expect(html).toContain("범위 0~168시간");
    expect(html).toContain(">시간<");
    expect(html).toContain(">%<");
    const valueInputs = (markup: string) => [...markup.matchAll(/<input[^>]*>/g)].map(match => match[0]).filter(tag => tag.includes('name="value:'));
    expect(valueInputs(html).filter(tag => tag.includes('disabled=""'))).toEqual([]);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    const locked = renderToStaticMarkup(createElement(RecheckLimitsForm, { fields: control.fields, revision: 6, readOnly: true, readOnlyReason: "읽기 전용 미리보기라 저장하지 않습니다." }));
    expect(valueInputs(locked).filter(tag => tag.includes('disabled=""'))).toHaveLength(5);
    expect(locked.match(/<button[^>]*disabled=""/g)).toHaveLength(5);
    expect(locked).toContain("읽기 전용 미리보기라 저장하지 않습니다.");
  });
});

describe("실시간 한도 화면의 잡별 묶음 폼(#877 이 더한 재판정 칸) — 빈 기본 칸 거절 버그에 걸리는가", () => {
  it("그려진 폼 그대로 재판정 칸 하나만 바꿔도 그 칸만 저장된다 — 다른 잡의 칸·빈 칸 때문에 거절되지 않는다", () => {
    const model = buildRuntimeSettingsAdminView({ row: ROW, observations: [], now: NOW, audit: [] });
    const html = renderToStaticMarkup(createElement(TranslationForm, { translation: model.translation, jobKnobs: model.jobKnobs, revision: 6 }));
    // 두 번째 폼(group jobs)의 칸을 브라우저가 보내는 그대로 모은다
    const jobsForm = html.split("<form").find(part => part.includes('name="group" value="jobs"'))!;
    const data = new FormData();
    for (const match of jobsForm.matchAll(/<input([^>]*)>/g)) {
      const name = /name="([^"]+)"/.exec(match[1])?.[1], value = /value="([^"]*)"/.exec(match[1])?.[1] ?? "";
      if (name && !/type="checkbox"/.test(match[1])) data.append(name, value.replace(/&amp;/g, "&"));
    }
    expect(data.get(`value:${P}.yieldHours`)).toBe("1");
    expect(runtimeSettingsPatchFromForm("jobs", data)).toEqual({ patch: {}, changed: [], issues: [] });
    data.set(`value:${P}.yieldHours`, "2");
    expect(runtimeSettingsPatchFromForm("jobs", data)).toEqual({ patch: { jobs: { "published-recheck": { yieldHours: 2 } } }, changed: [`${P}.yieldHours`], issues: [] });
  });
});

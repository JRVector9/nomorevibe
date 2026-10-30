import { desc, like } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { operationsAudit, operationsObservations } from "@/lib/db/schema";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";

/**
 * 실시간 한도 server action → saveRuntimeSettings → operations_audit → 화면 모형(PR 1a WP-D). 관리자·next/cache 만 가짜고 쓰기 관문(fence 읽기·TX 첫 lock)·감사 표·관측 표는 진짜다.
 *
 * WP-A 의 저장 본문이 아직 stub(runtime_settings_not_implemented)이면 아래 factory 가 같은 계약(CAS → resolveRuntimeSettings 검사 → null 은 키 제거 → 감사 한 줄)의
 * 메모리 저장으로 대신한다. 본문이 들어오면(readRuntimeSettingsRow 가 던지지 않으면) 진짜 모듈을 그대로 쓴다 — 그때 이 파일은 0151 행을 전제로 같은 단언을 한다.
 */
const admin = vi.hoisted(() => ({ login: null as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/operations/runtime-settings", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/operations/runtime-settings")>();
  try { await actual.readRuntimeSettingsRow(); return actual; }
  catch (error) { if (!(error instanceof Error) || error.message !== "runtime_settings_not_implemented") throw error; }
  const [{ resolveRuntimeSettings, storedSettingsVersion, RUNTIME_SETTING_GROUPS }, { adminAuditRow, settingsChanges }, { db }, { operationsAudit }] = await Promise.all([
    import("@/lib/operations/runtime-settings-schema"), import("@/lib/operations/admin-log"), import("@/lib/db"), import("@/lib/db/schema")]);
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const apply = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete base[key];
      else if (isObject(value)) { if (!isObject(base[key])) base[key] = {}; apply(base[key] as Record<string, unknown>, value); }
      else base[key] = value;
    }
    return base;
  };
  const state = { values: { version: 1 } as Record<string, unknown>, revision: 1, updatedBy: "migration:0151", updatedAt: new Date().toISOString() };
  const fake: typeof actual = { ...actual,
    readRuntimeSettingsRow: async () => ({ ...state, values: structuredClone(state.values) }),
    readRuntimeSettingsApply: async () => ({ savedVersion: storedSettingsVersion(state.values), roles: [], allApplied: false, attention: null }),
    saveRuntimeSettings: async (patch, actor, options) => {
      const audit = async (ok: boolean, detail: Record<string, unknown>, error?: string) => { await db.insert(operationsAudit).values(await adminAuditRow(actor,
        { action: actual.RUNTIME_SETTINGS_AUDIT_ACTION, target: actual.runtimeSettingsAuditTarget(options.group), detail, ok, error })); };
      if (!isObject(patch) || Object.keys(patch).some(key => key !== options.group || !(RUNTIME_SETTING_GROUPS as readonly string[]).includes(key))) {
        await audit(false, { patch }, "runtime_settings_invalid:patch"); return { ok: false, issues: ["runtime_settings_invalid:patch"] };
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== state.revision) {
        await audit(false, { expectedRevision: options.expectedRevision, revision: state.revision }, "stale_form"); return { ok: false, issues: ["stale_form"] };
      }
      const next = apply(structuredClone(state.values), patch);
      const before = resolveRuntimeSettings(state.values).settings, after = resolveRuntimeSettings(next);
      if (after.issues.length) { await audit(false, { issues: after.issues }, after.issues.join(",").slice(0, 300)); return { ok: false, issues: after.issues }; }
      state.values = next; state.revision += 1; state.updatedBy = actor; state.updatedAt = new Date().toISOString();
      const group = options.group as keyof typeof before;
      await audit(true, { revision: state.revision, changes: settingsChanges(before[group], after.settings[group]) });
      return { ok: true, revision: state.revision, version: storedSettingsVersion(next) };
    },
  };
  return fake;
});

const OBSERVATION_KEY = "service:text:runtime-settings-test";
let floor = 0;
beforeAll(async () => {
  ensureSchema();
  floor = await auditFloor();
  admin.login = { login: "operator" };
  // 모든 역할의 heartbeat 관측을 지우지 않는다 — 이 파일만의 열쇠 하나를 넣고 끝나면 지운다
  await db.insert(operationsObservations).values({ key: OBSERVATION_KEY, value: { status: "running", runtimeSettingsRegistryEnv: true, laneLimits: { jobMs: 180_000 } }, observedAt: new Date() })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value: { status: "running", runtimeSettingsRegistryEnv: true, laneLimits: { jobMs: 180_000 } }, observedAt: new Date() } });
});
afterAll(async () => { await db.delete(operationsObservations).where(like(operationsObservations.key, "service:text:runtime-settings-test%")); });

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const saved = () => auditRowsAfter(floor, "runtime-settings-save").orderBy(desc(operationsAudit.id));

it("저장 → 감사 한 줄(바뀐 값) → 화면 모형이 덮어씀·새 revision·감사 줄·env 등록부 역할을 보인다", async () => {
  const { saveRuntimeSettingsGroup } = await import("@/app/(operator)/admin/models/limits/actions");
  const { readRuntimeSettingsAdminView } = await import("@/lib/operations/admin-runtime-settings");
  const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  const { revision } = await readRuntimeSettingsRow();
  const result = await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: String(revision),
    "value:translation.product.batchChars": "6000", "initial:translation.product.batchChars": "8000", "stored:translation.product.batchChars": "0",
    "value:translation.product.maxAttempts": "4", "initial:translation.product.maxAttempts": "4" }));
  expect(result).toMatchObject({ ok: true, message: expect.stringContaining(`revision ${revision + 1}`) });
  const [row] = await saved();
  expect(row).toMatchObject({ actor: "operator", ok: true, target: "runtime_settings:translation" });
  expect(row.detail.revision).toBe(revision + 1);
  expect(JSON.stringify(row.detail.changes)).toContain("batchChars");
  expect(JSON.stringify(row.detail.changes)).toContain("6000");
  // 다른 키는 patch 에 없다 — 저장 문서는 바뀐 키만 담는다(sparse)
  expect(JSON.stringify(row.detail.changes)).not.toContain("maxAttempts");

  const view = await readRuntimeSettingsAdminView();
  expect(view).toMatchObject({ revision: revision + 1, updatedBy: "operator", rowError: null, issues: [] });
  expect(view.shortVersion).toMatch(/^v[0-9a-f]{6}$/);
  expect(view.translation.find(field => field.path === "translation.product.batchChars")).toMatchObject({ value: 6_000, overridden: true, input: "6000", defaultInput: "8000" });
  expect(view.translation.find(field => field.path === "translation.product.maxAttempts")).toMatchObject({ overridden: false });
  expect(view.audit[0]).toMatchObject({ actor: "operator", ok: true, group: "번역·묶음", revision: revision + 1, changes: ["공개 번역 묶음 글자 임계: 8000 → 6000"] });
  expect(view.roles.find(role => role.role === "text")).toMatchObject({ registryEnv: true });
  expect(view.budgets.find(row => row.job === "product-translate")).toMatchObject({ supervisorFloorMs: 180_000 });
});

it("CAS — 옛 revision 으로 다시 저장하면 stale_form 을 한국어로 거절하고 거절도 감사에 남는다; 문서는 바뀌지 않는다", async () => {
  const { saveRuntimeSettingsGroup } = await import("@/app/(operator)/admin/models/limits/actions");
  const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  const before = await readRuntimeSettingsRow();
  const result = await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: String(before.revision - 1),
    "value:translation.product.batchChars": "5000", "initial:translation.product.batchChars": "6000", "stored:translation.product.batchChars": "1" }));
  expect(result).toEqual({ issues: ["그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."] });
  const [row] = await saved();
  expect(row).toMatchObject({ ok: false, error: "stale_form", target: "runtime_settings:translation" });
  const after = await readRuntimeSettingsRow();
  expect(after.revision).toBe(before.revision);
  expect(JSON.stringify(after.values)).toContain("6000");
});

it("검사 거절 — 호출 상한보다 짧은 예산은 저장되지 않고 이유가 한국어로 그대로 보인다", async () => {
  const { saveRuntimeSettingsGroup } = await import("@/app/(operator)/admin/models/limits/actions");
  const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  const before = await readRuntimeSettingsRow();
  const result = await saveRuntimeSettingsGroup(null, form({ group: "budgets", expectedRevision: String(before.revision),
    "value:budgets.product-search-verify": "30", "initial:budgets.product-search-verify": "110", "initialAuto:budgets.product-search-verify": "0" }));
  expect(result).toEqual({ issues: ["키워드 검수 틱 예산이 호출 상한보다 짧습니다 — 예산 ≥ 상한 + 2초"] });
  expect((await readRuntimeSettingsRow()).revision).toBe(before.revision);
  expect((await saved())[0]).toMatchObject({ ok: false, target: "runtime_settings:budgets" });
});

it("「기본값으로」는 그 키만 지워 판이 default 로 돌아간다", async () => {
  const { saveRuntimeSettingsGroup } = await import("@/app/(operator)/admin/models/limits/actions");
  const { readRuntimeSettingsAdminView } = await import("@/lib/operations/admin-runtime-settings");
  const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  const before = await readRuntimeSettingsRow();
  const result = await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: String(before.revision),
    "value:translation.product.batchChars": "6000", "initial:translation.product.batchChars": "6000", "stored:translation.product.batchChars": "1", "reset:translation.product.batchChars": "on" }));
  expect(result).toMatchObject({ ok: true, message: expect.stringContaining("판 default") });
  const view = await readRuntimeSettingsAdminView();
  expect(view.translation.find(field => field.path === "translation.product.batchChars")).toMatchObject({ value: 8_000, overridden: false });
  expect(view.version).toBe("default");
  expect(view.audit[0].changes).toEqual(["공개 번역 묶음 글자 임계: 6000 → 8000"]);
});

it("비관리자는 쓰기 관문 뒤에서 막히고 저장 경로·감사에 닿지 않는다", async () => {
  const { saveRuntimeSettingsGroup } = await import("@/app/(operator)/admin/models/limits/actions");
  const count = (await saved()).length;
  admin.login = null;
  try {
    expect(await saveRuntimeSettingsGroup(null, form({ group: "translation", expectedRevision: "1", "value:translation.product.batchChars": "6000", "initial:translation.product.batchChars": "8000" })))
      .toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
  } finally { admin.login = { login: "operator" }; }
  expect((await saved()).length).toBe(count);
});

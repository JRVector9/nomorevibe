import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS, MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX, heldUnknownSql, readModelCapacityUnknownHoldMs,
  slotHoldingSql, storedUnknownHoldMsSql, unknownHoldSecondsFromStored } from "@/lib/llm/capacity-unknown-hold";
import { deviceCandidateSql, deviceModelQuotaGateSql, deviceRouteQuotaGateSql, deviceStateFromRow, deviceStateSql } from "@/lib/llm/capacity-devices";
import { helperGateStatesSql } from "@/lib/llm/capacity-helpers";
import { DEFAULT_RUNTIME_SETTINGS, GROUP_LABELS, RUNTIME_SETTING_LABELS, resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { applyRuntimeSettingsPatch } from "@/lib/operations/runtime-settings";

// 결과 미확정 점유(소유자 결정 2026-11-10) — SQL 조각·설정 읽기·장비 판정 SQL 의 순수 부분. DB 판정은 tests/integration/model-capacity-unknown-hold.test.ts.
const render = (query: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(query);
const generation = { epoch: 3, revision: 7, policyHash: "a".repeat(64) };
const HOLD = 600_000;

describe("hold window setting", () => {
  it("defaults to 600 s, accepts 0..3600 whole seconds and falls back to the default for anything else", () => {
    expect(DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS).toBe(600);
    expect(unknownHoldSecondsFromStored(undefined)).toBe(600);
    expect(unknownHoldSecondsFromStored(null)).toBe(600);
    expect(unknownHoldSecondsFromStored(0)).toBe(0);
    expect(unknownHoldSecondsFromStored(90)).toBe(90);
    expect(unknownHoldSecondsFromStored(MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS_MAX)).toBe(3600);
    for (const bad of [-1, 3601, 1.5, "600", true]) expect(unknownHoldSecondsFromStored(bad)).toBe(600);
  });

  it("reads runtime_settings in the caller's transaction; a principal without SELECT gets the default without touching the table", async () => {
    const queries: string[] = [];
    const executor = (rows: unknown[][]) => ({ execute: async (query: ReturnType<typeof sql>) => { queries.push(render(query).sql); return rows.shift() ?? []; } });
    expect(await readModelCapacityUnknownHoldMs(executor([[{ hold: 120 }]]) as never)).toBe(120_000);
    expect(queries.at(-1)).toContain(`rs."values"->'capacity'->'unknownHoldSeconds'`);
    expect(await readModelCapacityUnknownHoldMs(executor([[]]) as never)).toBe(600_000); // 행이 없으면 기본값
    queries.length = 0;
    expect(await readModelCapacityUnknownHoldMs(executor([[{ readable: false }]]) as never, { whenReadable: true })).toBe(600_000);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("has_table_privilege('public.runtime_settings', 'SELECT')");
    expect(await readModelCapacityUnknownHoldMs(executor([[{ readable: true }], [{ hold: 0 }]]) as never, { whenReadable: true })).toBe(0);
  });

  it("is an editable runtime settings group: default, label, bounds and the sparse patch", () => {
    expect(DEFAULT_RUNTIME_SETTINGS.capacity).toEqual({ unknownHoldSeconds: 600 });
    expect(GROUP_LABELS.capacity).toBe("모델 장부 점유");
    expect(RUNTIME_SETTING_LABELS["capacity.unknownHoldSeconds"]).toBe("결과 미확정 점유 유지(초)");
    expect(resolveRuntimeSettings({ version: 1 })).toMatchObject({ settings: { capacity: { unknownHoldSeconds: 600 } }, issues: [] });
    expect(resolveRuntimeSettings({ version: 1, capacity: { unknownHoldSeconds: 0 } })).toMatchObject({ settings: { capacity: { unknownHoldSeconds: 0 } }, issues: [] });
    expect(resolveRuntimeSettings({ version: 1, capacity: { unknownHoldSeconds: 4000 } }))
      .toMatchObject({ settings: { capacity: { unknownHoldSeconds: 600 } }, issues: ["runtime_settings_invalid:capacity.unknownHoldSeconds"] });
    expect(resolveRuntimeSettings({ version: 1, capacity: { holdMs: 1 } }).issues).toEqual(["unknown_setting:capacity.holdMs"]);
    expect(applyRuntimeSettingsPatch({ version: 1, budgets: { "crawl-tagline": 60_000 } }, "capacity", { capacity: { unknownHoldSeconds: 300 } }))
      .toEqual({ stored: { version: 1, budgets: { "crawl-tagline": 60_000 }, capacity: { unknownHoldSeconds: 300 } }, issues: [] });
    expect(applyRuntimeSettingsPatch({ version: 1, capacity: { unknownHoldSeconds: 300 } }, "capacity", { unknownHoldSeconds: null }))
      .toEqual({ stored: { version: 1 }, issues: [] });
  });
});

describe("SQL fragments", () => {
  it("0 renders the 2026-10-30 rule byte for byte; a window adds the indexed indeterminate arm with one bound value", () => {
    expect(render(slotHoldingSql("r", 0))).toEqual({ sql: "r.state IN ('reserved','dispatched')", params: [] });
    expect(render(heldUnknownSql("r", 0))).toEqual({ sql: "false", params: [] });
    const held = render(slotHoldingSql("r", HOLD));
    expect(held.sql).toBe("(r.state IN ('reserved','dispatched') OR (r.state = 'indeterminate' AND coalesce(r.dispatched_at, r.updated_at) > "
      + "(SELECT clock_timestamp() - $1::integer * interval '1 millisecond')))");
    expect(held.params).toEqual([HOLD]);
    // 관측 한 문장용: 저장값을 그 문장 안에서 읽는 식(같은 거르기, bind 값 없음)
    const inline = render(heldUnknownSql("r", storedUnknownHoldMsSql));
    expect(inline.params).toEqual([]);
    expect(inline.sql).toContain(`rs."values"->'capacity'->'unknownHoldSeconds' FROM runtime_settings rs WHERE rs.id = 1`);
    expect(inline.sql).toContain("<= 3600");
    expect(inline.sql).toContain("ELSE 600 END * 1000");
  });

  it("refuses a bad alias or an out-of-range window instead of rendering it", () => {
    expect(() => slotHoldingSql("r; drop", HOLD)).toThrow("model_capacity_unknown_hold_alias");
    expect(() => heldUnknownSql("r", -1)).toThrow("model_capacity_unknown_hold_invalid");
    expect(() => heldUnknownSql("r", 3_600_001)).toThrow("model_capacity_unknown_hold_invalid");
    expect(() => heldUnknownSql("r", 1.5)).toThrow("model_capacity_unknown_hold_invalid");
  });
});

describe("device admission and observation SQL with a hold window", () => {
  it("counts held unknowns in every occupancy CTE (helper_active · active · busy · route_use · model_use) and only there", () => {
    const query = render(deviceCandidateSql("supa", generation, "{}", HOLD));
    expect(query.sql.match(/r\.state = 'indeterminate' AND coalesce\(r\.dispatched_at, r\.updated_at\) > \(SELECT clock_timestamp\(\)/g)).toHaveLength(5);
    expect(query.sql.match(/r\.state IN \('reserved','dispatched'\)/g)).toHaveLength(5);
    expect(query.sql).toContain("(r.state = 'indeterminate') AS unknown");
    expect(query.sql).toContain("(count(*) FILTER (WHERE unknown))::int AS unknown FROM active");
    expect(query.params.filter(param => param === HOLD)).toHaveLength(5);
    // waiting 행·recent(settled/withdrawn) 판정은 바뀌지 않는다
    expect(query.sql).toContain("(r.state = 'settled' AND r.settled_at >=");
    // 0 이면 미확정 글자가 들어가지 않는다(예전 판정 그대로)
    const off = render(deviceCandidateSql("supa", generation, "{}", 0)).sql;
    expect(off).not.toContain("'indeterminate'");
    expect(off).toContain("false AS unknown");
  });

  it("the quota gates and the helper gate use the same rule; the state view returns held_unknown", () => {
    expect(render(deviceRouteQuotaGateSql("supa", generation, "{}", "product-search-verify", null, HOLD)).sql).toContain("r.state = 'indeterminate' AND coalesce(r.dispatched_at, r.updated_at)");
    expect(render(deviceModelQuotaGateSql("m3-mlx", generation, "gpt-oss-120b", null, HOLD)).sql).toContain("r.state = 'indeterminate' AND coalesce(r.dispatched_at, r.updated_at)");
    expect(render(helperGateStatesSql("supa", HOLD)).sql).toContain("r.model = g.model AND (r.state IN ('reserved','dispatched') OR (r.state = 'indeterminate'");
    expect(render(deviceStateSql("supa", generation, "{}", HOLD)).sql).toContain("c.total AS active, c.unknown AS held_unknown");
  });

  it("maps held_unknown to heldUnknown and leaves old row shapes without it", () => {
    const row = { device_id: "supa", source: "table" as const, limit_slots: 4, secondary_cap: 4, idle_ms: 60_000, reserve_slots: 0, active: 3,
      secondary_active: 0, secondary_bound: 4, primary_busy: false, lending: false, waiting: 2, waiting_primary: 0, version: 1, updated_at: null };
    expect(deviceStateFromRow({ ...row, held_unknown: 2 })).toMatchObject({ active: 3, heldUnknown: 2 });
    expect(deviceStateFromRow(row)).not.toHaveProperty("heldUnknown");
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { crawlSettings, jobs } from "@/lib/db/schema";
import { getSettings, saveSettings } from "@/lib/crawl/settings";
import { parseSetQwenAutoArgs, setQwenAutoMain } from "@/scripts/ops/set-qwen-auto";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

/** DR writer fence — 켜면 이 DB 가 fence 된 것으로 읽힌다(lib/operations/dr/epoch.ts writerSiteActive) */
const fenced = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/operations/dr/epoch", async (original) => {
  const actual = await original<typeof import("@/lib/operations/dr/epoch")>();
  return { ...actual, writerSiteActive: async (tx: Parameters<typeof actual.writerSiteActive>[0]) => !fenced.on && actual.writerSiteActive(tx) };
});

/**
 * 운영 스크립트(scripts/ops/set-qwen-auto.ts) — 화면과 같은 setter 로 Qwen-v2 자동 단계 하나를 켜고 끈다. 자기 DB 연결(QWEN_AUTO_DATABASE_URL)로
 * 실제 테스트 DB 에 쓴다. dry-run 은 쓰지 않고(작업 로그도 없다), 출력은 단계·전/후 값·거절 까닭뿐이다.
 */
const env = { QWEN_AUTO_DATABASE_URL: TEST_DATABASE_URL, USER: "tester" };
async function run(args: string[], over: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await setQwenAutoMain(args, { ...env, ...over }, (line) => { lines.push(line); });
  return { code, output: lines.join(""), json: JSON.parse(lines.join("")) as Record<string, unknown> };
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  fenced.on = false;
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await saveSettings({ enabled: true }, "test");
});

describe("set-qwen-auto", () => {
  it("dry-run 은 같은 검사만 하고 쓰지 않는다 — 설정도 작업 로그도 그대로", async () => {
    const floor = await auditFloor();
    const result = await run(["--step=splitTiebreak", "--enable", "--per-tick=5", "--reason=적체 회복", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.json).toEqual({ command: "set-qwen-auto", step: "splitTiebreak", dryRun: true, ok: true,
      before: { enabled: false, perTick: 10, dailyRejectCap: 50 }, after: { enabled: true, perTick: 5, dailyRejectCap: 50 } });
    expect((await getSettings()).qwenAuto.splitTiebreak).toEqual({ enabled: false, perTick: 10, dailyRejectCap: 50 });
    expect(await auditRowsAfter(floor)).toHaveLength(0);
    // 켜는 바꿈은 dry-run 에서도 사유를 받는다
    const refused = await run(["--step=splitTiebreak", "--enable", "--dry-run"]);
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ ok: false, dryRun: true, before: { enabled: false }, issues: [expect.stringContaining("까닭")] });
    expect(await auditRowsAfter(floor)).toHaveLength(0);
    // 출력에 DB 주소를 싣지 않는다
    expect(result.output).not.toContain(TEST_DATABASE_URL);
  });

  it("실제로 켜면 그 단계만 바꾸고 작업 로그에 ops:<이름>(token)으로 남긴다 — 끄기는 사유 없이 된다", async () => {
    const floor = await auditFloor();
    const before = (await getSettings()).qwenAuto;
    const result = await run(["--step=heldRetry", "--enable", "--per-tick=3", "--budget-seconds=30", "--reason=적체 회복", "--by=jr"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, dryRun: false, before: { enabled: false, perTick: 10 }, after: { enabled: true, perTick: 3, budgetSeconds: 30 } });
    const after = (await getSettings()).qwenAuto;
    expect(after.heldRetry).toMatchObject({ enabled: true, perTick: 3, budgetSeconds: 30 });
    expect({ ...after, heldRetry: before.heldRetry }).toEqual(before);
    const [row] = await auditRowsAfter(floor, "qwen-auto-settings");
    expect(row).toMatchObject({ actor: "ops:jr", actorKind: "token", ok: true, target: "crawl_settings",
      detail: { step: "heldRetry", before: { enabled: false }, after: { enabled: true, perTick: 3 }, reason: "적체 회복" } });
    // 켜면 그 단계를 도는 잡을 부른다(보류 재심사 → human-deepseek-review)
    expect((await db.select({ name: jobs.name }).from(jobs)).map((job) => job.name)).toContain("human-deepseek-review");

    const off = await run(["--step=heldRetry", "--disable"]);
    expect(off.code).toBe(0);
    expect((await getSettings()).qwenAuto.heldRetry.enabled).toBe(false);
    expect((await auditRowsAfter(floor, "qwen-auto-settings")).map((audit) => audit.actor).sort()).toEqual(["ops:jr", "ops:tester"]);
  });

  it("갈림 판가름의 하루 자동 거부 상한을 바꾼다 — 다른 단계에는 줄 수 없다", async () => {
    const result = await run(["--step=splitTiebreak", "--enable", "--daily-reject-cap=20", "--reason=적체 회복", "--by=jr"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, after: { enabled: true, perTick: 10, dailyRejectCap: 20 } });
    expect((await getSettings()).qwenAuto.splitTiebreak).toEqual({ enabled: true, perTick: 10, dailyRejectCap: 20 });
    expect(() => parseSetQwenAutoArgs(["--step=heldRetry", "--daily-reject-cap=5"])).toThrow("qwen_auto_usage");
    expect(parseSetQwenAutoArgs(["--step=splitTiebreak", "--daily-reject-cap=0"], { USER: "jr" })).toMatchObject({ enable: null, dailyRejectCap: 0 });
  });

  it("켜 둔 채 넓히는 바꿈(틱당 수·상한 올림·사유 더함)도 까닭을 받는다 — 좁히는 바꿈은 받지 않는다", async () => {
    expect((await run(["--step=splitTiebreak", "--enable", "--reason=적체 회복"])).code).toBe(0);
    const raised = await run(["--step=splitTiebreak", "--per-tick=20"]);
    expect(raised.code).toBe(1);
    expect(raised.json).toMatchObject({ ok: false, issues: [expect.stringContaining("까닭")] });
    expect((await run(["--step=splitTiebreak", "--daily-reject-cap=80"])).code).toBe(1);
    expect((await run(["--step=splitTiebreak", "--per-tick=20", "--reason=처리량"])).code).toBe(0);
    // 내리는 것은 까닭 없이 된다
    expect((await run(["--step=splitTiebreak", "--per-tick=5", "--daily-reject-cap=10"])).code).toBe(0);
    expect((await getSettings()).qwenAuto.splitTiebreak).toEqual({ enabled: true, perTick: 5, dailyRejectCap: 10 });
    // 보류 재심사 — 예산을 올리는 것도 넓히는 바꿈이다
    expect((await run(["--step=heldRetry", "--enable", "--reason=적체 회복"])).code).toBe(0);
    expect((await run(["--step=heldRetry", "--budget-seconds=60"])).code).toBe(1);
    expect((await run(["--step=heldRetry", "--budget-seconds=20"])).code).toBe(0);
  });

  it("fence 된 DB 에는 쓰지 않는다 — DR writer fence 가 첫 잠금이고, dry-run 은 읽기만 해 그대로 된다", async () => {
    const floor = await auditFloor();
    fenced.on = true;
    await expect(run(["--step=splitTiebreak", "--enable", "--reason=적체 회복"])).rejects.toThrow("site_fenced");
    expect((await getSettings()).qwenAuto.splitTiebreak.enabled).toBe(false);
    expect(await auditRowsAfter(floor)).toHaveLength(0);
    expect((await run(["--step=splitTiebreak", "--enable", "--reason=적체 회복", "--dry-run"])).code).toBe(0);
  });

  it("범위를 넘는 값은 쓰지 않는다 — 거절도 작업 로그에 남긴다", async () => {
    const floor = await auditFloor();
    const result = await run(["--step=auditSecondOpinion", "--enable", "--per-tick=99", "--reason=x"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, issues: [expect.stringContaining("qwenAuto.auditSecondOpinion.perTick")] });
    expect((await getSettings()).qwenAuto.auditSecondOpinion.enabled).toBe(false);
    expect(await auditRowsAfter(floor, "qwen-auto-settings")).toMatchObject([{ ok: false }]);
  });

  it("DB 주소는 전용 환경변수로만 — 없거나 PG 덮어쓰기가 있으면 연결하지 않는다. 인자는 엄격하게 읽는다", async () => {
    await expect(run(["--step=splitTiebreak", "--disable"], { QWEN_AUTO_DATABASE_URL: undefined })).rejects.toThrow("explicit_QWEN_AUTO_DATABASE_URL_required");
    await expect(run(["--step=splitTiebreak", "--disable"], { PGHOST: "elsewhere" })).rejects.toThrow("database_override_rejected");
    expect(() => parseSetQwenAutoArgs(["--step=review", "--enable"])).toThrow("qwen_auto_unknown_step");
    expect(() => parseSetQwenAutoArgs(["--step=splitTiebreak"])).toThrow("qwen_auto_nothing_to_change");
    expect(() => parseSetQwenAutoArgs(["--step=splitTiebreak", "--enable", "--disable"])).toThrow("qwen_auto_usage");
    expect(() => parseSetQwenAutoArgs(["--step=splitTiebreak", "--enable", "--budget-seconds=30"])).toThrow("qwen_auto_usage");
    expect(() => parseSetQwenAutoArgs(["--step=splitTiebreak", "--enable", "--per-tick=-1"])).toThrow("qwen_auto_invalid_number");
    expect(() => parseSetQwenAutoArgs(["--step=splitTiebreak", "--enable", "--by=a b"])).toThrow("qwen_auto_invalid_by");
    expect(parseSetQwenAutoArgs(["--step=publishedFilter", "--per-tick=4"], { USER: "jr" }))
      .toEqual({ step: "publishedFilter", enable: null, perTick: 4, budgetSeconds: null, dailyRejectCap: null, reason: null, by: "jr", dryRun: false });
  });
});

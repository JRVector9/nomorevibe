import { describe, expect, it } from "vitest";
import { mergeWithDefaults, settingsFormVersion, storedAuditHold, storedQwenAuto } from "@/lib/crawl/settings";
import { auditHoldSchema, crawlSettingsSchema, DEFAULT_AUDIT_HOLD, DEFAULT_CRAWL_SETTINGS, DEFAULT_QWEN_AUTO, QWEN_AUTO_STEPS, type QwenAutoSettings } from "@/lib/crawl/settings-schema";
import * as originMain from "./fixtures/settings-schema-55389b48";

/**
 * Qwen-v2 자동 단계 설정(qwenAuto) — 최상위 칸, 기본 꺼짐, 없거나 깨지면 꺼짐. 옛 코드(origin/main 55389b48)와 새 코드가 같은 행을 번갈아
 * 읽고 쓰는 배포·되돌림에서 감사 보류가 깨지지 않고, 옛 코드가 지운 자동 단계가 켬으로 되살아나지 않는다.
 */
const enabledEverywhere: QwenAutoSettings = {
  auditSecondOpinion: { enabled: true, perTick: 7 }, publishedFilter: { enabled: true, perTick: 5 }, splitTiebreak: { enabled: true, perTick: 12, dailyRejectCap: 30 },
  heldRetry: { enabled: true, perTick: 4, budgetSeconds: 30, reasons: ["ambiguous"] },
};
/** 새 코드가 운영자 문턱을 바꾸고 네 단계를 켠 뒤 저장한 행 — saveSettings 는 파싱한 설정 전체를 쓴다 */
const writtenByNewCode = crawlSettingsSchema.parse({ ...DEFAULT_CRAWL_SETTINGS, enabled: true,
  auditHold: { ...DEFAULT_AUDIT_HOLD, minConfidence: 0.97, categories: ["company"] }, qwenAuto: enabledEverywhere });

describe("기본값", () => {
  it("네 자동 단계는 모두 꺼짐으로 나간다 — 칸이 없는 행(첫 배포)도 꺼짐이다", () => {
    expect(QWEN_AUTO_STEPS).toEqual(["auditSecondOpinion", "publishedFilter", "splitTiebreak", "heldRetry"]);
    for (const step of QWEN_AUTO_STEPS) {
      expect(DEFAULT_QWEN_AUTO[step].enabled, step).toBe(false);
      expect(DEFAULT_CRAWL_SETTINGS.qwenAuto[step].enabled, step).toBe(false);
      expect(mergeWithDefaults({}).qwenAuto[step].enabled, step).toBe(false);
      expect(mergeWithDefaults({ enabled: true, auditHold: DEFAULT_AUDIT_HOLD }).qwenAuto[step].enabled, step).toBe(false);
    }
  });

  it("감사 보류의 모양은 origin/main 그대로다(strict) — 자동 단계를 그 안에 두지 않는다", () => {
    expect(Object.keys(DEFAULT_AUDIT_HOLD).sort()).toEqual(Object.keys(originMain.DEFAULT_AUDIT_HOLD).sort());
    expect(Object.keys(auditHoldSchema.shape).sort()).toEqual(Object.keys(originMain.auditHoldSchema.shape).sort());
    expect(Object.keys(crawlSettingsSchema.shape.secondReview.removeDefault().shape).sort())
      .toEqual(Object.keys(originMain.crawlSettingsSchema.shape.secondReview.removeDefault().shape).sort());
  });
});

describe("storedQwenAuto — 없거나 깨지면 그 단계만 꺼짐", () => {
  it("칸·단계가 없으면 꺼짐, 있으면 그 값", () => {
    expect(storedQwenAuto({})).toEqual(DEFAULT_QWEN_AUTO);
    expect(storedQwenAuto({ qwenAuto: { publishedFilter: { enabled: true, perTick: 3 } } }))
      .toEqual({ ...DEFAULT_QWEN_AUTO, publishedFilter: { enabled: true, perTick: 3 } });
    expect(storedQwenAuto({ qwenAuto: enabledEverywhere })).toEqual(enabledEverywhere);
  });

  it("깨진 단계는 꺼짐(빠진 칸을 기본값으로 채우지 않는다) — 다른 단계는 그대로", () => {
    for (const broken of [{ enabled: true }, { enabled: "yes", perTick: 3 }, { enabled: true, perTick: 0 }, { enabled: true, perTick: 3, extra: 1 }, "on", null, []]) {
      const read = storedQwenAuto({ qwenAuto: { ...enabledEverywhere, auditSecondOpinion: broken } });
      expect(read.auditSecondOpinion, JSON.stringify(broken)).toEqual(DEFAULT_QWEN_AUTO.auditSecondOpinion);
      expect(read.splitTiebreak).toEqual(enabledEverywhere.splitTiebreak);
    }
    for (const broken of ["on", null, [], 3]) expect(storedQwenAuto({ qwenAuto: broken }), JSON.stringify(broken)).toEqual(DEFAULT_QWEN_AUTO);
  });

  it("행의 다른 칸이 깨져 기본값으로 돌아가도 자동 단계는 저장된 값을 읽는다", () => {
    const settings = mergeWithDefaults({ enabled: "broken", qwenAuto: { splitTiebreak: { enabled: true, perTick: 4 } } });
    expect(settings.enabled).toBe(false);
    // 하루 자동 거부 상한이 없던 값(이 칸 전)은 설계한 기본 상한(50)으로 읽는다 — 안전 상한이라 기본값이 곧 설계값이다
    expect(settings.qwenAuto.splitTiebreak).toEqual({ enabled: true, perTick: 4, dailyRejectCap: 50 });
  });

  it("이 가지의 앞 커밋이 감사 보류 안에 적던 자동 단계 칸은 버리고 읽는다 — strict 라도 감사 보류가 깨지지 않는다", () => {
    const stale = { ...DEFAULT_AUDIT_HOLD, minConfidence: 0.97, autoSecondOpinion: { enabled: true, perTick: 10 }, publishedFilter: { enabled: true, perTick: 10 } };
    expect(storedAuditHold({ auditHold: stale })).toEqual({ ...DEFAULT_AUDIT_HOLD, minConfidence: 0.97 });
    // 그 칸은 자동 단계를 켜지 않는다 — 자동 단계는 최상위 qwenAuto 만 읽는다
    expect(mergeWithDefaults({ enabled: true, auditHold: stale }).qwenAuto.auditSecondOpinion.enabled).toBe(false);
  });

  it("하루 자동 거부 상한 — 0~500 정수. 깨지면 그 단계가 꺼진다", () => {
    expect(DEFAULT_QWEN_AUTO.splitTiebreak).toEqual({ enabled: false, perTick: 10, dailyRejectCap: 50 });
    expect(storedQwenAuto({ qwenAuto: { splitTiebreak: { enabled: true, perTick: 4, dailyRejectCap: 0 } } }).splitTiebreak)
      .toEqual({ enabled: true, perTick: 4, dailyRejectCap: 0 });
    for (const dailyRejectCap of [-1, 501, 2.5, "50"]) {
      expect(storedQwenAuto({ qwenAuto: { splitTiebreak: { enabled: true, perTick: 4, dailyRejectCap } } }).splitTiebreak.enabled, String(dailyRejectCap)).toBe(false);
    }
  });

  it("크롤 설정 폼의 판에 들지 않는다 — 스위치를 눌러도 열린 폼이 거절되지 않는다", () => {
    const off = DEFAULT_CRAWL_SETTINGS;
    expect(settingsFormVersion({ ...off, qwenAuto: enabledEverywhere })).toBe(settingsFormVersion(off));
  });
});

describe("옛 코드(origin/main)와 함께 도는 배포·되돌림", () => {
  it("새 코드가 쓴 행을 옛 스키마가 그대로 읽는다 — 감사 보류는 strict 로도 통과하고 자동 단계 칸은 버린다", () => {
    const parsed = originMain.crawlSettingsSchema.safeParse(writtenByNewCode);
    expect(parsed.success).toBe(true);
    expect(originMain.auditHoldSchema.safeParse(writtenByNewCode.auditHold).success).toBe(true);
    expect(parsed.data!.auditHold).toEqual({ enabled: true, minConfidence: 0.97, categories: ["company"], secondOpinionReject: true });
    expect(parsed.data).not.toHaveProperty("qwenAuto");
  });

  it("옛 코드가 다시 저장해 자동 단계 칸이 사라지면 새 코드는 모두 꺼짐으로 읽고, 운영자 문턱은 그대로다", () => {
    const rewrittenByOld = originMain.crawlSettingsSchema.parse(writtenByNewCode);
    const read = mergeWithDefaults(rewrittenByOld);
    expect(read.qwenAuto).toEqual(DEFAULT_QWEN_AUTO);
    expect(read.auditHold).toEqual({ enabled: true, minConfidence: 0.97, categories: ["company"], secondOpinionReject: true });
  });

  it("옛 코드의 행(자동 단계 칸 없음)을 새 코드가 다시 저장해도 옛 스키마가 읽는다", () => {
    const fromOld = originMain.crawlSettingsSchema.parse({ ...originMain.DEFAULT_CRAWL_SETTINGS, enabled: true });
    const resaved = crawlSettingsSchema.parse(mergeWithDefaults(fromOld));
    expect(originMain.crawlSettingsSchema.safeParse(resaved).success).toBe(true);
    expect(resaved.qwenAuto).toEqual(DEFAULT_QWEN_AUTO);
  });

  it("지난 가지가 적던 secondReview.splitTiebreak 칸은 읽지 않는다 — 켬으로 되살아나지 않는다", () => {
    const read = mergeWithDefaults({ enabled: true, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, splitTiebreak: { enabled: true, perTick: 9 } } });
    expect(read.qwenAuto.splitTiebreak.enabled).toBe(false);
    expect(read.secondReview).not.toHaveProperty("splitTiebreak");
  });
});

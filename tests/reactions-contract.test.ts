import { describe, expect, it } from "vitest";
import {
  kstDay, nextChangeCount, normalizeReactionComment, parseReactionSlugs, REACTION_CHANGES_PER_DAY, reviewReactionComment, validateReactionWrite,
} from "@/lib/domain/reactions/contract";

describe("써봤어요 입력 검사", () => {
  it("평가·태그·한 줄·출처·기기·언어를 받고 기본값을 채운다", () => {
    expect(validateReactionWrite({ verdict: "good" })).toEqual({
      verdict: "good", tags: [], comment: null, source: "panel", device: null, locale: "ko", trapped: false,
    });
    expect(validateReactionWrite({ verdict: "bad", tags: ["slow", "easy", "slow"], comment: "  느려요  ", source: "sheet", device: "phone", locale: "zh-Hant" }))
      .toEqual({ verdict: "bad", tags: ["easy", "slow"], comment: "느려요", source: "sheet", device: "phone", locale: "zh-Hant", trapped: false });
    // 모르는 언어는 기본 언어로 둔다
    expect(validateReactionWrite({ verdict: "meh", locale: "fr" }).locale).toBe("ko");
  });

  it.each([
    [null], [[]], [{ verdict: "great" }], [{ verdict: "good", tags: "easy" }], [{ verdict: "good", tags: ["easy", "nope"] }],
    [{ verdict: "good", tags: ["easy", "useful", "fast", "pretty", "free"] }], [{ verdict: "good", source: "admin" }],
    [{ verdict: "good", device: "tablet" }], [{ verdict: "good", comment: 3 }], [{ verdict: "good", website: 1 }],
  ])("틀린 입력 %j 은 400", (input) => {
    expect(() => validateReactionWrite(input)).toThrow(expect.objectContaining({ code: "reaction_invalid", status: 400 }));
  });

  it("한 줄은 140 코드 포인트까지 — 이모지도 한 글자로 센다", () => {
    expect(normalizeReactionComment("😀".repeat(140))).toBe("😀".repeat(140));
    expect(() => normalizeReactionComment("가".repeat(141))).toThrow(expect.objectContaining({ code: "reaction_invalid" }));
    expect(normalizeReactionComment("한 줄\n둘째\t줄 끝")).toBe("한 줄 둘째 줄 끝");
    expect(normalizeReactionComment("   ")).toBeNull();
    expect(normalizeReactionComment(undefined)).toBeNull();
  });

  it("숨은 칸에 값이 있으면 버릴 표시를 단다", () => {
    expect(validateReactionWrite({ verdict: "good", website: "http://spam.example" }).trapped).toBe(true);
    expect(validateReactionWrite({ verdict: "good", website: "  " }).trapped).toBe(false);
  });

  it("slug 목록은 틀린 것을 버리고 같은 것을 한 번만, 상한까지", () => {
    expect(parseReactionSlugs("a,b, a ,Bad,../x,,c-1")).toEqual(["a", "b", "c-1"]);
    expect(parseReactionSlugs(["x", 1, "y"])).toEqual(["x", "y"]);
    expect(parseReactionSlugs(Array.from({ length: 150 }, (_, index) => `p${index}`).join(","))).toHaveLength(100);
    expect(parseReactionSlugs(null)).toEqual([]);
  });
});

describe("익명 한 줄 자동 검사", () => {
  it.each([
    ["머리카락 경계가 깔끔해요. 한 번에 10장까지 됩니다.", null],
    ["Node.js 로 만든 것 같아요. v2.0 부터 빨라졌어요", null],
    ["ㅋㅋㅋ 좋아요!!", null],
    ["무료 크레딧 받으려면 bit.ly/abc", "link"],
    ["안내 문서: docs.example.com/start", "link"],
    ["https://example.com 참고", "link"],
    ["www.example 에 있어요", "link"],
    ["@example_dev 님 고마워요", "mention"],
    ["연락 주세요 someone@mail.example.kr", "link"],
    ["메일 me@example.net", "link"],
    ["텔레그램 @spam_seller", "mention"],
    ["ㅋㅋㅋㅋㅋㅋㅋㅋ", "repeated"],
    ["최고 최고 최고 최고", "repeated"],
    ["무료 크레딧 드려요", "lure"],
  ])("%s → %s", (comment, reason) => {
    expect(reviewReactionComment(comment)).toEqual({ state: reason ? "held" : "accepted", reason });
  });
});

describe("하루 변경 횟수 — KST 자정에 다시 센다", () => {
  it("KST 날짜는 UTC 15시에 바뀐다", () => {
    expect(kstDay(new Date("2026-10-20T14:59:59.999Z"))).toBe("2026-10-20");
    expect(kstDay(new Date("2026-10-20T15:00:00.000Z"))).toBe("2026-10-21");
  });

  it("처음 쓰면 1, 같은 날은 하나씩 늘고 한도에서 멈춘다", () => {
    const now = new Date("2026-10-20T05:00:00Z");
    expect(nextChangeCount(null, now)).toBe(1);
    expect(nextChangeCount({ changesToday: 3, updatedAt: new Date("2026-10-20T01:00:00Z") }, now)).toBe(4);
    expect(nextChangeCount({ changesToday: REACTION_CHANGES_PER_DAY - 1, updatedAt: now }, now)).toBe(REACTION_CHANGES_PER_DAY);
    expect(nextChangeCount({ changesToday: REACTION_CHANGES_PER_DAY, updatedAt: now }, now)).toBeNull();
  });

  it("KST 자정을 넘으면 한도를 채웠어도 다시 1부터", () => {
    const full = REACTION_CHANGES_PER_DAY;
    // 23:59 KST 에 한도 → 00:00 KST 에 다시
    expect(nextChangeCount({ changesToday: full, updatedAt: new Date("2026-10-20T14:59:00Z") }, new Date("2026-10-20T15:00:00Z"))).toBe(1);
    // UTC 날짜가 달라도 KST 로 같은 날이면 이어서 센다(01:00 KST → 23:00 KST)
    expect(nextChangeCount({ changesToday: full, updatedAt: new Date("2026-10-19T16:00:00Z") }, new Date("2026-10-20T14:00:00Z"))).toBeNull();
    // UTC 로 같은 날이어도 KST 로 다음 날이면 다시(09:30 KST → 다음 날 08:30 KST)
    expect(nextChangeCount({ changesToday: full, updatedAt: new Date("2026-10-20T00:30:00Z") }, new Date("2026-10-20T23:30:00Z"))).toBe(1);
  });
});

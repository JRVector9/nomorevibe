import { describe, expect, it } from "vitest";
import { badgeTextWidth, escapeXml, formatBadgeCount, listedBadgeSvg, triedBadgeSvg, verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { clampCardText } from "@/lib/me/share-card";

describe("README 배지", () => {
  it("검증 배지는 주소·모양을 바꾸지 않는다", () => {
    const svg = verifiedBadgeSvg();
    expect(svg).toContain('width="156" height="20"');
    expect(svg).toContain("✓ verified");
    expect(svg).toContain("#0a7d4f");
  });

  it("공개 제품 배지는 사실만 말하고 이름을 가린다", () => {
    const svg = listedBadgeSvg(`<b onload="x">&'s`);
    expect(svg).toContain(">listed</text>");
    expect(svg).not.toContain("<b ");
    expect(svg).toContain("&lt;b onload=&quot;x&quot;&gt;&amp;&apos;s is listed on nomorevibe");
    expect(listedBadgeSvg("한글타자", "ko")).toContain(">소개됨</text>");
    expect(escapeXml("a\u0000b\u001fc")).toBe("abc");
  });

  it("써본 사람 숫자는 천 단위로 묶고 칸 폭이 글자를 따른다", () => {
    expect(formatBadgeCount(1234)).toBe("1,234");
    expect(formatBadgeCount(-3)).toBe("0");
    expect(formatBadgeCount(12.9)).toBe("12");
    expect(triedBadgeSvg("tiny-cron", 1234)).toContain(">tried by 1,234</text>");
    expect(triedBadgeSvg("tiny-cron", 12, "ko")).toContain(">써본 사람 12</text>");
    const narrow = Number(/width="(\d+)"/.exec(triedBadgeSvg("a", 3))![1]);
    const wide = Number(/width="(\d+)"/.exec(triedBadgeSvg("a", 1_234_567))![1]);
    expect(wide).toBeGreaterThan(narrow);
    expect(badgeTextWidth("소개됨")).toBeGreaterThan(badgeTextWidth("abc"));
  });
});

describe("공유 카드 글 자르기", () => {
  it("두 줄 남짓에서 말줄임표로 자른다", () => {
    expect(clampCardText("짧은 소개", 46)).toBe("짧은 소개");
    const cut = clampCardText("가".repeat(80), 46);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(cut)).toHaveLength(47);
    expect(clampCardText("a  b\n c", 46)).toBe("a b c");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { badgeTextWidth, escapeXml, formatBadgeCount, listedBadgeSvg, triedBadgeSvg, verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { cardFontOrder, clampCardText } from "@/lib/me/share-card";
import nextConfig from "@/next.config";

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

describe("공유 카드 글꼴", () => {
  it("카드 언어의 글꼴을 앞에, 나머지 둘을 뒤에 둔다", () => {
    expect(cardFontOrder("ko")).toEqual(["kr", "sc", "tc"]);
    expect(cardFontOrder("en")).toEqual(["kr", "sc", "tc"]);
    expect(cardFontOrder("zh-Hans")).toEqual(["sc", "kr", "tc"]);
    expect(cardFontOrder("zh-Hant")).toEqual(["tc", "kr", "sc"]);
  });

  it("저장소에 WOFF 여섯 개와 라이선스가 있다 — 밖에서 받지 않는다", () => {
    const dir = path.join(process.cwd(), "lib/me/fonts");
    for (const script of ["kr", "sc", "tc"]) {
      for (const weight of [400, 700]) {
        const file = readFileSync(path.join(dir, `noto-sans-${script}-${weight}.woff`));
        expect(file.subarray(0, 4).toString("latin1")).toBe("wOFF");
        expect(file.length).toBeLessThan(2_000_000);
      }
    }
    expect(readFileSync(path.join(dir, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
  });

  it("standalone 빌드에 글꼴 폴더가 실린다", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/\\[locale\\]/p/\\[slug\\]/share-card.png"]).toEqual(["./lib/me/fonts/*.woff"]);
  });
});

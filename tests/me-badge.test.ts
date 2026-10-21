import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeTextWidth, escapeXml, formatBadgeCount, listedBadgeSvg, triedBadgeSvg, verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { cardFontOrder, cardScripts, clampCardText, drawableText, fontCoverage, shareCardPng } from "@/lib/me/share-card";
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
    const dir = path.join(process.cwd(), "assets/fonts");
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
    expect(nextConfig.outputFileTracingIncludes?.["/\\[locale\\]/p/\\[slug\\]/share-card.png"]).toEqual(["./assets/fonts/*.woff"]);
  });
});

describe("공유 카드 — 밖으로 글꼴을 받으러 가지 않는다", () => {
  const font = (name: string) => readFileSync(path.join(process.cwd(), "assets/fonts", name));
  afterEach(() => { vi.unstubAllGlobals(); });

  it("WOFF cmap 에서 글리프가 있는 글자를 읽는다 — KR 은 한글·라틴, SC 는 간체·가나, 이모지는 어디에도 없다", () => {
    const kr = fontCoverage(font("noto-sans-kr-400.woff"));
    const sc = fontCoverage(font("noto-sans-sc-700.woff"));
    for (const char of ["A", "가", "힣", "★", "…", " "]) expect(kr.has(char.codePointAt(0)!), char).toBe(true);
    for (const char of ["汉", "か"]) expect(sc.has(char.codePointAt(0)!), char).toBe(true);
    for (const char of ["漢", "🚀", "ế", "ภ"]) expect(kr.has(char.codePointAt(0)!), char).toBe(false);
    expect(sc.has("🚀".codePointAt(0)!)).toBe(false);
  });

  it("카드 언어의 글꼴만 싣고, 그 글꼴에 없는 글자를 담은 글꼴만 더 싣는다", async () => {
    expect(await cardScripts("ko", "tiny-cron 자연어 일정을 cron 식으로 🚀")).toEqual(["kr"]);
    expect(await cardScripts("en", "Turns plain words into cron")).toEqual(["kr"]);
    expect(await cardScripts("en", "汉字 tool")).toEqual(["kr", "sc"]);
    expect(await cardScripts("zh-Hans", "简体 한글")).toEqual(["sc", "kr"]);
    expect(await cardScripts("zh-Hant", "繁體")).toEqual(["tc"]);
  });

  it("그릴 수 없는 글자는 뺀다 — 이모지·베트남어 성조·태국어", () => {
    const covers = fontCoverage(font("noto-sans-kr-700.woff"));
    const fonts = [{ script: "kr" as const, weight: 700 as const, data: new ArrayBuffer(0), covers }];
    expect(drawableText("🚀 Rocket ✨ Tiếng ภาษา 한글", fonts, 700)).toBe(" Rocket  Ting  한글");
    expect(drawableText("e\u0301", fonts, 700)).toBe("é");
    expect(drawableText("한글 abc", [], 400)).toBe(" abc");
  });

  it("이모지·드문 글자가 있는 카드도 네트워크 없이 PNG 를 그린다", async () => {
    const outbound: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/^https?:/.test(url)) {
        outbound.push(url);
        throw new Error("network disabled in tests");
      }
      return real(input, init);
    }));
    const png = await shareCardPng({ name: "🚀 Rocket", tagline: "Tiếng Việt ภาษาไทย 漢字 かな 한글 ✨", brandLine: "AI로 만든 서비스",
      chips: [{ text: "GitHub ★ 12" }, { text: "Hacker News 🔥 30", hn: true }], url: "nomorevibe.example/p/rocket", date: "2026-10-20 기준" }, "en");
    const bytes = Buffer.from(png);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(outbound).toEqual([]);
  }, 60_000);
});

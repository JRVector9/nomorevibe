import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { policy as ko } from "@/messages/ko/policy";
import { policy as en } from "@/messages/en/policy";
import { policy as ja } from "@/messages/ja/policy";
import { policy as zhHans } from "@/messages/zh-Hans/policy";
import { policy as zhHant } from "@/messages/zh-Hant/policy";

/**
 * 게재 기준(/policy)의 자동 수집·복제·AI 학습 금지 조항 초안(2026-11-14 「외부 수집 방지 2단계」, 병합 금지 Draft PR).
 * 모든 언어 약관에 같은 조항 키가 비어 있지 않게 있고, 화면이 그 키를 모두 그리는지 본다.
 */
const KEYS = [
  "automation.title",
  "automation.intro",
  "automation.scraping",
  "automation.copying",
  "automation.training",
  "automation.allowed",
  "automation.ownTools",
  "automation.measures",
  "automation.contact",
] as const;

const catalogs: Record<string, Record<string, string>> = { ko, en, ja, "zh-Hans": zhHans, "zh-Hant": zhHant };

describe("policy terms: automated collection and AI training clause", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`${locale} has every clause key with non-empty text`, () => {
      for (const key of KEYS) {
        expect(typeof catalog[key], `${locale} ${key}`).toBe("string");
        expect(catalog[key].trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} clause carries no defensive values (trap paths, numeric limits)`, () => {
      for (const key of KEYS) {
        expect(catalog[key], `${locale} ${key}`).not.toMatch(/\d/);
        expect(catalog[key], `${locale} ${key}`).not.toMatch(/\/(api|go|admin)\b/);
      }
    });
  }

  it("translated catalogs are not just the Korean text", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      if (locale === "ko") continue;
      expect(catalog["automation.training"], locale).not.toBe(ko["automation.training"]);
    }
  });

  it("the policy page renders the clause section and every key", () => {
    const page = readFileSync(path.join(process.cwd(), "app/(public)/[locale]/(content)/policy/page.tsx"), "utf8");
    expect(page).toContain('id="automation"');
    expect(page).toContain('{ id: "automation", title: t("automation.title") }');
    for (const key of KEYS) expect(page, key).toContain(`t("${key}")`);
  });
});

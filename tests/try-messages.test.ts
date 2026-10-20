import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tryPanelMessages } from "@/components/feedback/try-messages";
import { REACTION_TAGS, REACTION_VERDICTS } from "@/lib/me/contract";
import { LOCALES } from "@/lib/i18n/locales";
import { getDictionary } from "@/lib/i18n/dictionary";

/** 상세 써보기 판에는 me 사전 중 판이 쓰는 열쇠만 싣는다(엣지에 남는 HTML) — 판이 쓰는 열쇠는 하나도 빠지지 않아야 한다 */

const source = (file: string) => readFileSync(path.join(__dirname, "..", file), "utf8");
/** 판(TryPanel)·칸(ReactionFields, try 판)·쓰기 요청 오류(reaction-api)에 글자 그대로 적힌 열쇠 */
function usedKeys(): string[] {
  const text = ["components/feedback/TryPanel.tsx", "components/feedback/ReactionFields.tsx", "components/feedback/reaction-api.ts"].map(source).join("\n");
  const literal = [...text.matchAll(/"((?:try|verdict|tag)\.[A-Za-z.]+)"/g)].map((match) => match[1]);
  return [...new Set([...literal, ...REACTION_VERDICTS.map((verdict) => `verdict.${verdict}`), ...REACTION_TAGS.map((tag) => `tag.${tag}`)])];
}

describe("tryPanelMessages", () => {
  it.each(LOCALES)("%s — 판이 쓰는 열쇠는 모두 남고, 마이페이지 탭의 글은 빠진다", async (locale) => {
    const me = await getDictionary(locale, "me");
    const picked = tryPanelMessages(me);
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(picked[key as keyof typeof picked], key).toBe(me[key as keyof typeof me]);
    expect(Object.keys(picked).every((key) => /^(?:try|verdict|tag)\./.test(key))).toBe(true);
    expect(Object.keys(picked).length).toBeLessThan(Object.keys(me).length / 5);
    expect(Buffer.byteLength(JSON.stringify(picked))).toBeLessThan(6_000);
  });
});

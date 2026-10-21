import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REACTION_FIELD_LABELS } from "@/components/feedback/ReactionFields";
import { tryPanelMessages } from "@/components/feedback/try-messages";
import { REACTION_TAGS, REACTION_VERDICTS } from "@/lib/me/contract";
import { LOCALES } from "@/lib/i18n/locales";
import { getDictionary } from "@/lib/i18n/dictionary";

/** 상세 써보기 판에는 me 사전 중 판이 쓰는 열쇠만 싣는다(엣지에 남는 HTML) — 판이 쓰는 열쇠는 하나도 빠지지 않아야 한다 */

const source = (file: string) => readFileSync(path.join(__dirname, "..", file), "utf8");
/** 마이페이지 고치기(tried)에서만 쓰는 칸 열쇠 — 판(try)은 그리지 않는다 */
const triedOnly = new Set<string>(Object.values(REACTION_FIELD_LABELS.tried).filter((key) => !(Object.values(REACTION_FIELD_LABELS.try) as string[]).includes(key)));

/** 판(TryPanel)·칸(ReactionFields)·쓰기 요청 오류(reaction-api)에 글자 그대로 적힌 "머리.이름" 꼴 열쇠 — 머리를 가리지 않는다 */
function usedKeys(): string[] {
  const text = ["components/feedback/TryPanel.tsx", "components/feedback/ReactionFields.tsx", "components/feedback/reaction-api.ts"].map(source).join("\n");
  const literal = [...text.matchAll(/["'`]([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)["'`]/g)].map((match) => match[1]).filter((key) => !triedOnly.has(key));
  return [...new Set([...literal, ...REACTION_VERDICTS.map((verdict) => `verdict.${verdict}`), ...REACTION_TAGS.map((tag) => `tag.${tag}`)])];
}

describe("tryPanelMessages", () => {
  it.each(LOCALES)("%s — 판이 쓰는 열쇠는 모두 사전에 있고 판 몫에 남으며, 마이페이지 탭의 글은 빠진다", async (locale) => {
    const me = await getDictionary(locale, "me");
    const picked = tryPanelMessages(me);
    const keys = usedKeys();
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("try.error.load");
    for (const key of keys) {
      // 양쪽에 다 없는 열쇠(undefined === undefined)로 통과하지 않게 사전에 있는지부터 본다
      expect(typeof me[key as keyof typeof me], key).toBe("string");
      expect(picked[key as keyof typeof picked], key).toBe(me[key as keyof typeof me]);
    }
    expect(Object.keys(picked).every((key) => /^(?:try|verdict|tag)\./.test(key))).toBe(true);
    expect(Object.keys(picked).length).toBeLessThan(Object.keys(me).length / 5);
    expect(Buffer.byteLength(JSON.stringify(picked))).toBeLessThan(6_000);
  });

  it("판이 판 몫 밖의 열쇠를 쓰면 잡는다", () => {
    // 칸의 tried 열쇠는 판이 그리지 않아 빼지만, 판이 쓰는 칸 열쇠는 모두 try 머리다
    expect(Object.values(REACTION_FIELD_LABELS.try).every((key) => key.startsWith("try."))).toBe(true);
    expect([...triedOnly].every((key) => key.startsWith("tried."))).toBe(true);
    expect(usedKeys().some((key) => key.startsWith("tried."))).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 2026-11-07: prototype.css 의 `.admin-prototype button { color: inherit }` 가 cascade layer 밖에 있어 Tailwind 유틸리티(@layer utilities)를
 * 늘 이겼다 — 「bg-fg … text-bg」 단추(연결 저장 등)의 글자가 배경과 같은 색이 되어 보이지 않았다. 화면 뿌리 아래 요소 기본 글자색은 base 층에만 둔다.
 * (컴포넌트 클래스가 붙은 선택자 — 예: .segmented a — 는 그 컴포넌트의 의도라 여기서 보지 않는다.)
 */
const root = path.resolve(__dirname, "..");
const css = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** 한 겹 중첩까지의 @layer 블록을 지운 나머지 = 층 밖 규칙 */
const unlayered = (source: string) => source.replace(/@layer[^{;]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
// 이번에 고친 범위: 화면 뿌리 아래 폼 요소(단추·입력)의 글자색, LLM 운영 화면의 링크 글자색.
// prototype.css 의 `.admin-prototype a { color }`·`button { border: 0 }`·제목 margin 도 층 밖이라 유틸리티를 이기지만 관리자 전체 모양이 바뀌어 PR 5 로 미뤘다.
const ROOT_ELEMENT = /^(\.admin-prototype\s+(button|input|textarea|select)|\.llm-ops\s+a)$/;

describe("관리자 CSS — 화면 뿌리 아래 폼 요소·링크의 기본 글자색은 유틸리티를 덮지 않는다", () => {
  it.each(["app/(operator)/admin/prototype.css", "app/(operator)/admin/models/llm-ops.css"])("%s", (file) => {
    const offenders: string[] = [];
    for (const [, selector, body] of unlayered(css(file)).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/(^|;)\s*color\s*:/.test(body)) continue;
      for (const part of selector.split(",").map(text => text.trim())) if (ROOT_ELEMENT.test(part)) offenders.push(part);
    }
    expect(offenders).toEqual([]);
    expect(css(file)).toMatch(/@layer base\s*\{/);
  });

  it("층 밖 판정이 실제로 잡는다(대조)", () => {
    expect(unlayered(".admin-prototype button { color: inherit; } @layer base { .x a { color: red; } }")).not.toContain(".x a");
    expect(unlayered(".admin-prototype button { color: inherit; }")).toContain(".admin-prototype button");
  });
});

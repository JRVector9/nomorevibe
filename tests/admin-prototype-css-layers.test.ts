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
// 고친 범위(선택자 → 층 밖에 두면 안 되는 속성):
// - PR 2: 화면 뿌리 아래 폼 요소(단추·입력)의 글자색, LLM 운영 화면의 링크 글자색.
// - PR 5: 화면 뿌리 아래 링크의 글자색(text-accent-ink 를 덮었다), 단추 테두리(border 를 덮었다), 제목·문단 바깥 여백(mt-2 등을 덮었다),
//   시안 「.flex」의 가운데 정렬·간격·줄바꿈(items-*·gap-*·flex-nowrap 을 덮고 flex-col 자식을 가운데로 몰았다).
//   링크 밑줄 없음은 승인 시안의 모양이라 일부러 층 밖에 둔다(옮기면 underline 을 적은 링크에 밑줄이 새로 생긴다 — 전후 스크린샷으로 확인).
// 글자 크기(font: inherit·제목 font-size)는 관리자 글자 크기 조절(--admin-font-delta)이 쓰므로 일부러 층 밖에 둔다 — 여기서 보지 않는다.
const ROOT_ELEMENT: readonly (readonly [RegExp, RegExp])[] = [
  [/^\.admin-prototype\s+(button|input|textarea|select)$/, /(^|;)\s*color\s*:/],
  [/^\.llm-ops\s+a$/, /(^|;)\s*color\s*:/],
  [/^\.admin-prototype\s+a$/, /(^|;)\s*color\s*:/],
  [/^\.admin-prototype\s+button$/, /(^|;)\s*border\s*:/],
  [/^\.admin-prototype\s+(h[1-6]|p)$/, /(^|;)\s*margin\s*:/],
  // 시안의 「.flex」는 Tailwind flex 와 이름이 같다 — 층 밖이면 items-*·gap-*·flex-nowrap 을 덮고 flex-col 자식을 가운데로 몬다
  [/^\.admin-prototype\s+\.flex$/, /(^|;)\s*(align-items|gap|flex-wrap)\s*:/],
];

describe("관리자 CSS — 화면 뿌리 아래 요소의 기본 모양(글자색·테두리·여백)은 유틸리티를 덮지 않는다", () => {
  it.each(["app/(operator)/admin/prototype.css", "app/(operator)/admin/models/llm-ops.css"])("%s", (file) => {
    const offenders: string[] = [];
    for (const [, selector, body] of unlayered(css(file)).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const part of selector.split(",").map(text => text.trim())) {
        for (const [pattern, property] of ROOT_ELEMENT) if (pattern.test(part) && property.test(body)) offenders.push(`${part} { ${body.trim()} }`);
      }
    }
    expect(offenders).toEqual([]);
    expect(css(file)).toMatch(/@layer base\s*\{/);
  });

  it("옮긴 규칙은 base 층 안에 그대로 있다 — 클래스가 없는 요소의 모양은 바뀌지 않는다", () => {
    const base = css("app/(operator)/admin/prototype.css").match(/@layer base\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/)?.[1] ?? "";
    expect(base).toMatch(/\.admin-prototype a\s*\{\s*color:\s*inherit;\s*\}/);
    expect(base).toMatch(/\.admin-prototype button\s*\{\s*border:\s*0;\s*\}/);
    expect(base).toMatch(/\.admin-prototype h1,\.admin-prototype h2,\.admin-prototype h3,\.admin-prototype h4,\.admin-prototype p\s*\{\s*margin:\s*0;\s*\}/);
    // 시안 「.flex」는 components 층(시안 화면은 그대로), 세로 flex(flex-col)는 stretch 로 되돌린다
    const components = css("app/(operator)/admin/prototype.css").match(/@layer components\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/)?.[1] ?? "";
    expect(components).toMatch(/\.admin-prototype \.flex\s*\{[^}]*align-items:\s*center;[^}]*gap:\s*9px;/);
    expect(components).toMatch(/\.admin-prototype \.flex\.flex-col\s*\{\s*align-items:\s*stretch;\s*\}/);
    // 글자 크기 조절·링크 밑줄 없음은 층 밖 그대로
    expect(unlayered(css("app/(operator)/admin/prototype.css"))).toMatch(/\.admin-prototype a\s*\{\s*text-decoration:\s*none;\s*\}/);
    expect(unlayered(css("app/(operator)/admin/prototype.css"))).toMatch(/\.admin-prototype h1\s*\{\s*font-size:\s*calc\(28px/);
  });

  it("층 밖 판정이 실제로 잡는다(대조)", () => {
    expect(unlayered(".admin-prototype button { color: inherit; } @layer base { .x a { color: red; } }")).not.toContain(".x a");
    expect(unlayered(".admin-prototype button { color: inherit; }")).toContain(".admin-prototype button");
    const sample = unlayered(".admin-prototype a { color: inherit; } .admin-prototype a { text-decoration: none; } .admin-prototype p { margin: 0; } .admin-prototype .button { border: 1px solid; }");
    const hits = [...sample.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selector, body]) => ROOT_ELEMENT.some(([pattern, property]) => pattern.test(selector.trim()) && property.test(body)));
    expect(hits.map(([, selector]) => selector.trim())).toEqual([".admin-prototype a", ".admin-prototype p"]);
  });
});

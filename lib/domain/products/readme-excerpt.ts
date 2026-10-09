import { parseEntities } from "parse-entities";

/**
 * 상세 '소개'를 채우는 README 발췌.
 *
 * 공개 제품의 43%는 설명이 한 줄 소개와 같고 메이커 프로필은 없다(2026-10-02 실측). 검색용으로 저장한
 * README 본문(products.search_readme)은 88%에 있으므로 그 첫 문단들을 소개 자리에 쓴다.
 *
 * 저장된 README 는 lib/crawl/readme.ts 를 거친 글이다 — 제목의 # 은 떨어져 짧은 한 줄로 남고, 뱃지는
 * 이미지가 빠져 " (주소)" 만 남는다. 발췌는 문장이지 목차가 아니므로 링크 나열 줄·제목 줄·코드 블록·표는
 * 버리고, 괄호 안 주소와 굵게 표시(**)·인용 접두사는 지우고 엔티티는 글자로 푼다.
 * 문단 단위로 600자까지 담고, 담은 글이 최소 분량도 안 되는데(영문 80자, CJK 10자 이상이면 30자)
 * 다음 문단이 넘치면(첫 문단부터 긴 README) 그 문단을 문장 경계에서 자른다. 프레임워크가 만들어 준 README
 * 그대로면 제품 소개가 아니므로 없다고 한다.
 *
 * 발췌는 평문이다(2026-10-08 UX 감사 UX-17) — 상세는 이 글을 줄바꿈만 살려 글자로 그린다(HTML 로 넣지 않는다).
 * 그래서 마크다운 기호가 그대로 보이지 않게 여기서 푼다: 목록 기호(- * +, 체크 상자)는 "• ", 인라인 코드는
 * 따옴표(`)만 떼고, 기울임·굵게·취소선은 글자만, 링크는 이름만 남기고 이미지·배지는 지운다. 줄 머리의 #·가로줄도 지운다.
 * 엔티티를 풀기 전에 남은 HTML 태그·주석을 걷는다 — 풀고 나서 생긴 '<script>' 같은 글은 README 가 글자로 보여 주려던 것이다.
 */
const MAX = 600;
const MIN = 80;
const MIN_CJK = 30;
const CJK_CHARACTERS = 10;
const CJK = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/** 이 이하 낱말의 한 줄이 마침표·느낌표로 끝나지 않으면 제목으로 본다("Why use Calico?" 같은 물음꼴 제목도) */
const HEADING_WORDS = 6;
/** 프레임워크 템플릿 README 의 첫 문장 — 공개 제품 README 6,273건 중 219건(2026-09-23 복사본) */
const SCAFFOLD = /^(?:This is a Next\.js project bootstrapped with|This template provides a minimal setup to get React working in Vite|Run and deploy your AI Studio app)/;
/** 엔티티를 풀기 전에 남아 있는 HTML 태그(<p align="center">·<img …>·<br/>) — 이름이 글자로 시작하는 것만. '< 5' 같은 비교는 남는다 */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;

export function readmeExcerpt(readme: string | null | undefined, tagline: string): string | null {
  if (!readme) return null;
  const unquoted = readme
    .replace(/^[ \t]{0,3}(?:>[ \t]*)+/gm, "")
    .replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gm, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(HTML_TAG, " ");
  const paragraphs = parseEntities(unquoted, { nonTerminated: false })
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1")
    // 원문 마크다운의 링크·배지를 먼저 이름만 남기고, 저장 때 "이름 (주소)"가 된 링크의 주소는 그다음에 지운다
    .split("\n").map(plainLine).join("\n")
    .replace(/\s*\(https?:\/\/[^)\s]+\)/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("|") && !isNavigation(paragraph) && !isHeading(paragraph));
  let text = "";
  for (const paragraph of paragraphs) {
    const joined = text ? `${text}\n\n${paragraph}` : paragraph;
    if (joined.length <= MAX) {
      text = joined;
      continue;
    }
    if (!hasEnoughText(text)) text = leadingSentences(joined) || text;
    break;
  }
  if (!hasEnoughText(text) || text === tagline.trim() || SCAFFOLD.test(text)) return null;
  return text;
}

/** 한 줄의 마크다운 기호를 푼다 — 줄 머리(제목·가로줄은 줄째, 목록은 기호만)를 먼저, 그다음 줄 안의 글자 꾸밈 */
function plainLine(line: string): string {
  if (/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/.test(line) || /^[ \t]{0,3}#{1,6}[ \t]/.test(line)) return "";
  const body = line.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/, "• ");
  // 인라인 코드 안은 꾸밈으로 읽지 않는다 — `__init__`·`*.md` 는 따옴표만 뗀다. split 은 [글, `, 코드, 글, …] 차례로 준다
  return body.split(/(`+)(.+?)\1/).map((part, index) => index % 3 === 0 ? plainInline(part) : index % 3 === 2 ? part.trim() : "").join("");
}

/** 이미지·배지는 지우고 링크는 이름만, 기울임·굵게·취소선은 글자만. 낱말 안의 밑줄(snake_case)은 그대로 둔다 */
function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)__(?=\S)([^_]*?\S)__(?!\w)/g, "$1$2")
    .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([^~]*?\S)~~/g, "$1");
}

/** "Docs - Community - Roadmap - Why PostHog?" 같은 메뉴 줄 — 구분 기호로 나뉜 조각이 셋 이상이고 모두 짧다 */
function isNavigation(paragraph: string): boolean {
  const parts = paragraph.split(/\s[-|·•]\s/);
  return parts.length >= 3 && parts.every((part) => part.trim().split(/\s+/).length <= 4);
}

/** "Getting Started"·"🚀 Key Features"·"## Install"·"What is Tokei?" 같은 제목 — 마침표 없이 끝나는 짧은 한 줄 */
function isHeading(paragraph: string): boolean {
  if (!paragraph.includes("\n") && /^#{1,6}\s/.test(paragraph)) return true;
  // 띄어쓰기 없는 CJK 문단도 충분한 분량이면 본문이다.
  if ((paragraph.match(CJK)?.length ?? 0) >= CJK_CHARACTERS && hasEnoughText(paragraph)) return false;
  return !paragraph.includes("\n") && paragraph.split(" ").length <= HEADING_WORDS && !/[.!。！]$/.test(paragraph);
}

/** CJK 본문은 짧아도 내용을 담는다. 한두 글자만 섞인 영문은 기존 최소 분량을 유지한다. */
function hasEnoughText(text: string): boolean {
  return text.length >= MIN || (text.length >= MIN_CJK && (text.match(CJK)?.length ?? 0) >= CJK_CHARACTERS);
}

/** 앞에서부터 MAX 자 안에서 끝나는 문장들. 그 안에 문장 끝이 없으면 빈 문자열 */
function leadingSentences(text: string): string {
  const prefix = text.slice(0, MAX + 1);
  const endings = [...prefix.matchAll(/[.!?](?=\s)|[。！？]/g)].filter((match) => match.index < MAX);
  const last = endings.at(-1);
  return last ? prefix.slice(0, last.index + 1) : "";
}

import { sql } from "drizzle-orm";
import { productKoreanTaglines, products } from "@/lib/db/schema";

/**
 * 한국어 한 줄 소개(UX-13) — 지금 소개를 모델이 한국어 한 줄로 옮긴 것과, 그 줄을 믿어도 되는지 가리는 검사.
 *
 * 한국어 서비스인데 첫 화면 카드의 소개가 거의 영어·중국어였다(2026-10-08 UX 감사). 모델이 옮긴 글은 채워졌다는 것만으로
 * 내보내지 않는다 — 아래 검사(checkKoreanTagline)를 통과한 줄만 남기고, 버린 것은 사유별로 센다(korean-taglines.ts).
 * 게이트웨이 호출은 lib/crawl/translate.ts, 대기열과 저장은 korean-taglines.ts, 잡은 lib/jobs/products/korean-tagline.ts 다.
 */

const HANGUL = /[가-힣]/;
/** 한자·가나 — 중국어·일본어 소개를 옮기지 않고 되돌려 준 것을 가린다 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

/**
 * 이미 한국어인 줄인가 — 띄어 쓴 낱말 중 한글이 든 것이 절반 이상.
 *
 * 글자 수로 재면(translate.ts needsKorean, 한글 30%) "Claude Code용 MCP 서버" 같은 한국어 소개도 영어 낱말에 밀려
 * 옮길 글이 된다. 한글 한 음절은 영문자 두세 개 몫이라 낱말로 센다. 아래 NEEDS_KOREAN 이 같은 기준의 SQL 이다.
 */
export function isKoreanLine(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const korean = words.filter((word) => HANGUL.test(word)).length;
  return korean > 0 && korean * 2 >= words.length;
}

/** isKoreanLine 이 아닌 공개 소개 — 잡이 옮길 대상(korean-taglines.ts). 한글이 하나도 없는 대부분의 행은 정규식 하나로 끝난다 */
export const NEEDS_KOREAN = sql`(btrim(${products.tagline}) <> '' and (${products.tagline} !~ '[가-힣]'
  or (select count(*) filter (where w ~ '[가-힣]') * 2 < count(*) from regexp_split_to_table(btrim(${products.tagline}), '\\s+') w)))`;

/**
 * 화면이 쓸 한국어 소개 — 지금 소개(products.tagline)에서 옮긴 것만. 소개가 바뀌었으면 null 이라 원문이 보인다.
 *
 * 목록·상세 조회에 `extras: { ...taglineKoField }` 또는 select 의 한 칸으로 붙인다. 바깥 products 를 별칭 없이 부르는
 * 쿼리에서만 쓴다(repository.ts notDown 과 같다). 제품마다 기본키 한 번이라 목록 한 쪽에 몇 ms 다.
 */
export const taglineKo = sql<string | null>`(select k.tagline_ko from ${productKoreanTaglines} k
  where k.product_id = ${products.id} and k.source_tagline = ${products.tagline})`;
export const taglineKoField = { taglineKo: taglineKo.as("tagline_ko") };

/** 한 줄로 서는 길이 — 지시는 60자 안팎, 받는 쪽은 고유명사 몫까지 80자 */
export const KOREAN_TAGLINE_MAX = 80;
const KOREAN_TAGLINE_MIN = 4;

export type KoreanTaglineReject =
  | "empty" | "multiline" | "markup" | "boilerplate" | "too_long" | "too_short"
  | "not_korean" | "foreign_script" | "name_lost" | "invented_number" | "invented_term";

/** 링크·마크다운·HTML — 한 줄 소개에 있을 것이 아니다 */
const MARKUP = /https?:\/\/|www\.|\]\(|\*\*|__|`|^#{1,6}\s|^[-*•]\s|<\/?[a-z][^>]*>/i;
/** 거절·머리말·설명 — 옮긴 글이 아니라 모델의 말이다 */
const BOILERPLATE = /죄송|번역할 수 없|옮길 수 없|다음은|^(?:번역|요약|한국어|한 줄 소개|소개)\s*[:：]|as an ai|i'?m sorry|i cannot|i can'?t/i;
const QUOTED = /^(["'“‘「『]).*(["'”’」』])$/;
/** 원문이 풀어 쓴 말을 모델이 줄여 쓰는 약어 — 원문에 없어도 지어낸 말이 아니다 */
const COMMON_TERMS = new Set(["ai", "api", "cli", "gui", "ui", "ux", "sdk", "llm", "ide", "os", "pc", "sns", "url", "db", "app"]);

export type KoreanTaglineCheck = { ok: true; line: string } | { ok: false; reason: KoreanTaglineReject };

/**
 * 모델이 옮긴 한 줄을 그대로 믿지 않는다 — 채워졌다가 아니라 맞게 옮겼는지를 규칙으로 가린다(메모: 생성물 품질은 항상 검토).
 *
 * 다듬기: 공백을 한 칸으로, 감싼 따옴표와 끝 마침표를 뗀다. 버리기:
 *  - 빈 줄·여러 줄·링크/마크다운·거절이나 머리말("번역:")
 *  - 너무 길거나 짧음, 한글 낱말이 절반 미만(영어를 되돌려 줌), 이름에 없는 한자·가나(중국어를 그대로 둠)
 *  - 원문에 그대로 적힌 제품 이름이 사라짐(음역함 — "Wireshark" → "와이어샤크")
 *  - 원문에 없는 숫자나 영문 낱말(지어낸 기능·플랫폼) — 원문이 풀어 쓴 흔한 약어(AI·CLI…)는 둔다
 */
export function checkKoreanTagline(output: string, source: { name: string; tagline: string }): KoreanTaglineCheck {
  const trimmed = output.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: "multiline" };
  const spaced = trimmed.replace(/\s+/g, " ");
  // 통째로 감싼 따옴표만 뗀다 — "'오구오구'로 기록"의 앞 따옴표는 글의 일부다
  const line = (QUOTED.test(spaced) ? spaced.slice(1, -1) : spaced).replace(/[.。]+$/, "").trim();
  if (!line) return { ok: false, reason: "empty" };
  if (MARKUP.test(line)) return { ok: false, reason: "markup" };
  if (BOILERPLATE.test(line)) return { ok: false, reason: "boilerplate" };
  const length = [...line].length;
  if (length > KOREAN_TAGLINE_MAX) return { ok: false, reason: "too_long" };
  if (length < KOREAN_TAGLINE_MIN) return { ok: false, reason: "too_short" };
  if (!isKoreanLine(line) || (line.match(/[가-힣]/g)?.length ?? 0) < 2) return { ok: false, reason: "not_korean" };
  if ([...line].some((char) => CJK.test(char) && !source.name.includes(char))) return { ok: false, reason: "foreign_script" };

  // 이름이 원문에 대소문자까지 그대로 있을 때만 본다 — "Notes" 와 "take notes" 처럼 흔한 낱말은 옮겨도 된다
  const name = source.name.trim();
  if (name.length >= 2 && source.tagline.includes(name) && !line.toLowerCase().includes(name.toLowerCase())) {
    return { ok: false, reason: "name_lost" };
  }
  const original = `${source.name} ${source.tagline}`.toLowerCase();
  const digits = new Set((original.match(/\d+(?:[.,]\d+)*/g) ?? []).map((value) => value.replace(/[.,]/g, "")));
  if ((line.match(/\d+(?:[.,]\d+)*/g) ?? []).some((value) => !digits.has(value.replace(/[.,]/g, "")))) {
    return { ok: false, reason: "invented_number" };
  }
  const terms = (line.match(/[A-Za-z][A-Za-z0-9+#]*(?:[.-][A-Za-z0-9+#]+)*/g) ?? []).map((term) => term.toLowerCase());
  if (terms.some((term) => !original.includes(term) && !COMMON_TERMS.has(term))) return { ok: false, reason: "invented_term" };
  return { ok: true, line };
}

export type KoreanTaglineBatch = { ok: true; outputs: string[] } | { ok: false; error: string };

/**
 * 받은 배열을 그대로 믿지 않는다 — 개수가 다르면 통째로 실패다(어느 줄이 어느 제품인지 모른다).
 * 문자열이 아닌 항목은 빈 줄로 두어 검사에서 'empty' 로 버린다.
 */
export function parseKoreanTaglines(content: string, count: number): KoreanTaglineBatch {
  const body = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(body.match(/\[[\s\S]*\]/)?.[0] ?? "null"); } catch { return { ok: false, error: "invalid_output" }; }
  if (!Array.isArray(parsed) || parsed.length !== count) return { ok: false, error: "invalid_output" };
  return { ok: true, outputs: parsed.map((item) => typeof item === "string" ? item : "") };
}

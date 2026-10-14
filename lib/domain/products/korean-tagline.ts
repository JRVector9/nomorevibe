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
/**
 * 시점을 이르는 말(1인칭·3인칭) — 숫자가 아니다. "first-person shooter" 를 옮기면 원문에 없던 1이 생겨
 * 지어낸 숫자로 네 번 버려지고 영어 원문이 남았다(doodle-district-2, 2026-10-14).
 */
const GRAMMATICAL_PERSON = /[123]인칭/g;

/**
 * 원문이 글로 쓴 수 — 모델은 "three-channel"·"Über zehn"·"七十八张"·"11M+"를 3채널·10개·78장·1100만으로 옮긴다. 원문에 숫자로
 * 적힌 글자만 믿었더니 맞게 옮긴 줄이 지어낸 숫자로 네 번 버려져 원문으로 남았다(포기 530건, 다시 옮긴 표본 중 걸린 29건의 28건이
 * 맞게 옮긴 것, 2026-10-14). 그래서 값으로 맞춘다 — 낱말 수·한자 수·로마 숫자·뒤에 붙은 단위를 읽고, 옮긴 줄의 한국어 단위도 값으로 친다.
 * 값이 다르면 그대로 걸린다: "1+ млрд ₽"(10억)를 "1조 원"으로 옮긴 줄.
 */
const NUMBER_WORDS = new Map<string, number>(Object.entries({
  // 영어
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1e3, million: 1e6, millions: 1e6,
  billion: 1e9, dozen: 12, single: 1, double: 2, twice: 2, triple: 3, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  // 스페인어·포르투갈어
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, veinte: 20,
  cien: 100, ciento: 100, mil: 1e3, millón: 1e6, millones: 1e6, um: 1, uma: 1, dois: 2, duas: 2, três: 3, quatro: 4, sete: 7, oito: 8,
  nove: 9, dez: 10, vinte: 20, cem: 100, milhão: 1e6, milhões: 1e6,
  // 프랑스어·독일어·이탈리아어
  une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, douze: 12, vingt: 20, cent: 100, mille: 1e3,
  milliard: 1e9, milliards: 1e9, ein: 1, eine: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
  zehn: 10, elf: 11, zwölf: 12, zwanzig: 20, hundert: 100, tausend: 1e3, millionen: 1e6, milliarden: 1e9, due: 2, tre: 3, quattro: 4,
  cinque: 5, sei: 6, sette: 7, otto: 8, dieci: 10, venti: 20, cento: 100, milioni: 1e6,
  // 러시아어
  один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, двадцать: 20, тридцать: 30, сто: 100, тысяча: 1e3, тысячи: 1e3, тысяч: 1e3, тыс: 1e3,
  миллион: 1e6, миллиона: 1e6, миллионов: 1e6, млн: 1e6, миллиард: 1e9, миллиарда: 1e9, миллиардов: 1e9, млрд: 1e9,
}));
/** 한자 수 — 七十八 → 78, 三百五十 → 350, 一万 → 10,000 */
const CJK_NUMERALS = new Map<string, number>([["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["兩", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10], ["百", 100], ["千", 1e3], ["万", 1e4], ["萬", 1e4], ["亿", 1e8], ["億", 1e8]]);
/** 숫자 뒤에 붙는 단위 — 3M+·1.5 billion·1+ млрд·30万·5천 */
const SCALES = new Map<string, number>([["k", 1e3], ["m", 1e6], ["mn", 1e6], ["mio", 1e6], ["b", 1e9], ["bn", 1e9], ["mrd", 1e9],
  ["lakh", 1e5], ["lakhs", 1e5], ["cr", 1e7], ["crore", 1e7], ["crores", 1e7], ["천", 1e3], ["만", 1e4], ["억", 1e8], ["조", 1e12], ...[...CJK_NUMERALS, ...NUMBER_WORDS].filter(([, value]) => value >= 1e3)]);
/** 한 글자 단위 — 뒤에 글자가 이어져도 단위다(30万用户, 10만명) */
const CHAR_SCALE = /^[千万萬亿億천만억조]/;
const SOURCE_NUMBER = /(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)|\d+(?:[.,]\d+)*)(?:\s?\+?\s?(\p{L}+))?/gu;
/** 옮긴 줄의 수 — 붙여 쓴 한국어 단위(1100만·3천·1조)까지 */
const LINE_NUMBER = /(\d+(?:[.,]\d+)*)([천만억조]*)/g;
const ROMAN = new Map([["I", 1], ["V", 5], ["X", 10]]);
const valueKey = (value: number) => Number(value.toPrecision(12));

/** 숫자 글자의 값 — 1,500·1.500 은 1500 과 1.5 둘 다, 500 000 은 500000 */
function digitValues(text: string): number[] {
  if (/\s/.test(text)) return [Number(text.replace(/\s/g, ""))];
  const decimal = text.replace(/[.,](?=\d+$)/, "#").replace(/[.,]/g, "").replace("#", ".");
  return [Number(text.replace(/[.,]/g, "")), Number(decimal)];
}

/**
 * 원문에 적힌 수의 값 — 숫자와 뒤의 단위, 낱말 수(붙어 선 것은 하나로: seventy-eight → 78), 한자 수, 로마 숫자(II).
 * bare 는 단위 없이 적힌 숫자 글자다 — 옮긴 줄의 "1만"·"제14조"가 단위가 아니라 '만(뿐)'·'조(條)'일 때를 가린다.
 */
function sourceNumbers(text: string): { values: Set<number>; bare: Set<string> } {
  const values = new Set<number>(), bare = new Set<string>();
  const add = (value: number) => { if (Number.isFinite(value)) values.add(valueKey(value)); };
  for (const [, digits, word] of text.matchAll(SOURCE_NUMBER)) {
    const scale = word ? SCALES.get(word.toLowerCase()) ?? (CHAR_SCALE.test(word) ? SCALES.get(word[0]) : undefined) : undefined;
    for (const value of digitValues(digits)) { add(value); if (scale) add(value * scale); }
    if (!scale) bare.add(digits.replace(/[.,\s]/g, ""));
  }
  let total = 0, current = 0, inRun = false;
  for (const token of [...text.toLowerCase().split(/[^\p{L}]+/u), ""]) {
    const value = NUMBER_WORDS.get(token);
    if (value === undefined) {
      if (inRun) add(total + current);
      total = 0; current = 0; inRun = false;
      continue;
    }
    add(value);
    inRun = true;
    if (value === 100) current = (current || 1) * 100;
    else if (value >= 1e3) { total += (current || 1) * value; current = 0; } else current += value;
  }
  for (const [run] of text.matchAll(/[零〇一二两兩三四五六七八九十百千万萬亿億]+/g)) {
    let sum = 0, section = 0, digit = 0;
    for (const char of run) {
      const value = CJK_NUMERALS.get(char) ?? 0;
      if (value < 10) digit = value;
      else if (value < 1e4) { section += (digit || 1) * value; digit = 0; } else { sum += (section + digit || 1) * value; section = 0; digit = 0; }
    }
    add(sum + section + digit);
  }
  for (const [numeral] of text.matchAll(/(?<![A-Za-z])[IVX]{2,4}(?![A-Za-z])/g)) {
    const digits = [...numeral].map((char) => ROMAN.get(char) ?? 0);
    add(digits.reduce((sum, value, index) => sum + (value < (digits[index + 1] ?? 0) ? -value : value), 0));
  }
  return { values, bare };
}

export type KoreanTaglineCheck = { ok: true; line: string } | { ok: false; reason: KoreanTaglineReject };

/**
 * 모델이 옮긴 한 줄을 그대로 믿지 않는다 — 채워졌다가 아니라 맞게 옮겼는지를 규칙으로 가린다(메모: 생성물 품질은 항상 검토).
 *
 * 다듬기: 공백을 한 칸으로, 감싼 따옴표와 끝 마침표를 뗀다. 버리기:
 *  - 빈 줄·여러 줄·링크/마크다운·거절이나 머리말("번역:")
 *  - 너무 길거나 짧음, 한글 낱말이 절반 미만(영어를 되돌려 줌), 이름에 없는 한자·가나(중국어를 그대로 둠)
 *  - 원문에 그대로 적힌 제품 이름이 사라짐(음역함 — "Wireshark" → "와이어샤크")
 *  - 원문에 없는 숫자나 영문 낱말(지어낸 기능·플랫폼) — 원문이 풀어 쓴 흔한 약어(AI·CLI…)는 둔다
 *    수는 값으로 맞춘다 — 원문이 글로 쓴 수·단위(three → 3, 11M → 1100만)도 원문에 있는 수다
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
  const { values, bare } = sourceNumbers(`${source.name} ${source.tagline}`);
  // 원문에 같은 숫자 글자가 있거나 값이 같으면 된다. 한국어 단위가 붙은 수(1조)는 원문에 단위 없이 적힌 같은 글자가 있을 때만 글자로 본다 —
  // "1+ млрд"의 1 로 1조를, "100k+"의 100 으로 100만을 받지 않는다. "⌘⇧1만 누르면"·"제14조"는 원문의 1·14 로 받는다
  const invented = ([, number, units]: RegExpMatchArray) => !(units === "" ? digits : bare).has(number.replace(/[.,]/g, ""))
    && !values.has(valueKey(Number(number.replace(/,/g, "")) * [...units].reduce((product, unit) => product * (SCALES.get(unit) ?? 1), 1)));
  if ([...line.replace(GRAMMATICAL_PERSON, "").matchAll(LINE_NUMBER)].some(invented)) {
    return { ok: false, reason: "invented_number" };
  }
  const terms = (line.match(/[A-Za-z][A-Za-z0-9+#]*(?:[.-][A-Za-z0-9+#]+)*/g) ?? []).map((term) => term.toLowerCase());
  if (terms.some((term) => !original.includes(term) && !COMMON_TERMS.has(term))) return { ok: false, reason: "invented_term" };
  return { ok: true, line };
}

/** 다시 보낼 앞부분 — 이 길이 안에서 처음 끝나는 문장·구절. 너무 짧은 머리(이름뿐)는 건너뛴다 */
const LEAD_MAX = 120;
const LEAD_MIN = 20;
/** 문장·구절이 끝나는 자리 — 낱말 사이의 마침표·쌀점(5.5 같은 소수점은 아니다), 전각 문장부호, 띄어 쓴 | — – */
const CLAUSE_END = /[.!?:;](?=\s)|[。！？：；]|\s[|—–]\s/g;

/**
 * 긴 소개의 앞 문장 — 같은 소개가 '너무 긺'·'빈 줄'로 버려졌을 때 다시 보낼 글(lib/jobs/products/korean-tagline.ts).
 *
 * 모델은 180자짜리 영어 소개를 80자 안으로 줄이지 못해 같은 입력에 네 번 버려지곤 했다(ShellRS·lemo-opuscar, 2026-10-11).
 * 앞 문장만 보내면 한 줄로 선다. 검사(checkKoreanTagline)는 보낸 앞부분을 원문으로 삼으므로 지어낸 말은 그대로 걸린다.
 * 끊을 자리가 없으면 원문 그대로다.
 */
export function leadClause(tagline: string): string {
  const text = tagline.trim();
  for (const match of text.matchAll(CLAUSE_END)) {
    if (match.index > LEAD_MAX) break;
    if (match.index >= LEAD_MIN) return text.slice(0, match.index).trim();
  }
  return text;
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

import { reviewHash, type ReviewSnapshot } from "./agent-review-contract";

/**
 * 공개분 변경 재검수(published-recheck.ts)의 "뜻있게 바뀌었나" 판정 — 순수 모듈(DB·네트워크 없음).
 *
 * 견주는 것은 모델이 본 제품 내용(심사 입력의 product 부분, agent-review-contract.ts buildReviewProduct)의 아홉 칸뿐이다(2026-11-09 운영자 결정):
 *   name · description · pageText · readme · topics · url · accessMode · packageProof · linksOwnGithub
 * 보지 않는 것: repoFacts(스타·푸시·생성 시각), 근거(evidence)·스캔, 정책 판(policy). 해시로는 가르지 않는다 —
 * sourceRevisionHash 는 다시 받을 때마다 바뀌고, inputHash 에는 스타·푸시 시각이 들어 있다.
 *
 * 글 칸(description·pageText·readme)은 생존 확인이 6시간마다 본문을 다시 채우고 움직이는 페이지는 늘 조금씩 바뀌어서, 글자 그대로 견주면 줄이
 * 넘친다. 그래서 낱말 모음으로 견준다:
 *   1. 낱말 = NFKC·소문자로 고친 글자 덩어리(\p{L}\p{M}\p{N}_). 숫자가 섞인 낱말은 버린다(시각·날짜·횟수·판 번호·해시처럼 늘 바뀌는 것).
 *      한 글자 낱말도 버린다. 한자·가나 덩어리는 띄어 쓰지 않으므로 두 글자씩 끊는다(한글은 띄어 쓰므로 그대로).
 *   2. 같음 = 두 낱말 모음의 자카드 유사도 |A∩B| / |A∪B|(되풀이는 세지 않는다).
 *   3. 바뀜 = 유사도가 문턱(실시간 한도 jobs.published-recheck.minSimilarity, 기본 60%) 아래이고, 달라진 낱말(대칭차)이 그 칸의 최소 수 이상.
 *      낱말이 거의 없던 글이 생기거나(appeared) 있던 글이 거의 사라지면(vanished — 주인이 떠나 빈 페이지) 문턱과 상관없이 바뀜이다.
 *      README 는 처음에 받지 못했던 것("")이 나중에 채워지는 일이 많아 생김은 세지 않는다.
 * 짧은 칸: name 은 숫자를 뺀 낱말 모음이 하나라도 다르면, topics 는 소문자 모음이 다르면, url 은 scheme·host 소문자·끝 / 를 고친 값이 다르면,
 * accessMode·linksOwnGithub·packageProof 는 값이 다르면 바뀜이다. 기준에 그 칸이 없으면(그 칸이 생기기 전의 1차 승인) 그 칸은 견주지 않는다.
 */
export const RECHECK_FIELDS = ["name", "description", "pageText", "readme", "topics", "url", "accessMode", "packageProof", "linksOwnGithub"] as const;
export type RecheckField = (typeof RECHECK_FIELDS)[number];
export type RecheckContent = Partial<{
  name: string; description: string; pageText: string; readme: string; topics: string[]; url: string | null; accessMode: string;
  packageProof: unknown; linksOwnGithub: boolean;
}>;

/** 1차 심사 입력에 packageProof 가 들어온 판(agent-review-contract.ts REVIEW_PROMPT_VERSION 2026-10-06.1) — 그 전 승인에는 없어도 "없음"이 아니다 */
export const PACKAGE_PROOF_SINCE = "2026-10-06.1";

/**
 * 제품 내용에서 견줄 아홉 칸만 고른다. 없는 칸은 빼 둔다(모름). packageProofKnown 이면 packageProof 가 없을 때 "없음"([])으로 적는다 —
 * 지금 만든 내용과 0171 뒤의 재검수 답은 늘 그렇고, 1차 승인은 그 판(PACKAGE_PROOF_SINCE) 뒤의 것만 그렇다.
 */
export function recheckContent(product: Partial<ReviewSnapshot["product"]> | null | undefined, options: { packageProofKnown: boolean }): RecheckContent {
  const source = (product ?? {}) as Record<string, unknown>;
  const content: Record<string, unknown> = {};
  for (const field of RECHECK_FIELDS) if (Object.hasOwn(source, field) && source[field] !== undefined) content[field] = source[field];
  if (content.packageProof === undefined && options.packageProofKnown) content.packageProof = [];
  return content as RecheckContent;
}

export const recheckContentHash = (content: RecheckContent): string => reviewHash(content);

/** 1차 승인 기록의 판이 packageProof 를 싣는 판인가("YYYY-MM-DD.n" 은 글자 순서가 시간 순서다) */
export const packageProofKnownSince = (promptVersion: string | null | undefined): boolean =>
  typeof promptVersion === "string" && promptVersion >= PACKAGE_PROOF_SINCE;

const WORD = /[\p{L}\p{M}\p{N}_]+/gu;
const DIGIT = /\p{N}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 낱말 모음 — 위 규칙 1 */
export function contentTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();
  if (typeof value !== "string" || !value) return tokens;
  for (const word of value.normalize("NFKC").toLowerCase().match(WORD) ?? []) {
    if (DIGIT.test(word)) continue;
    const chars = [...word];
    if (CJK.test(word)) {
      if (chars.length === 1) tokens.add(word);
      for (let index = 0; index + 1 < chars.length; index++) tokens.add(chars[index] + chars[index + 1]);
      continue;
    }
    if (chars.length >= 2) tokens.add(word);
  }
  return tokens;
}

/** 자카드 유사도와 대칭차 크기. 둘 다 비면 1 */
export function tokenSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): { similarity: number; difference: number } {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return { similarity: union === 0 ? 1 : shared / union, difference: union - shared };
}

/** 칸마다의 글 규칙 — 이보다 적은 낱말은 "거의 없음", substantial 이상이면 "있음", 바뀜으로 셀 대칭차의 최소 */
const TEXT_RULES = {
  description: { sparse: 1, substantial: 3, minDifference: 3, appearCounts: true },
  pageText: { sparse: 5, substantial: 20, minDifference: 10, appearCounts: true },
  readme: { sparse: 5, substantial: 20, minDifference: 10, appearCounts: false },
} as const;
type TextField = keyof typeof TEXT_RULES;

export type RecheckFieldChange = { field: RecheckField; kind: "changed" | "appeared" | "vanished"; similarity?: number };
export type RecheckComparison = { changed: boolean; fields: RecheckFieldChange[] };
export type RecheckRule = {
  /** 0~1. 글 칸의 유사도가 이 아래면 바뀜(실시간 한도의 % 를 100 으로 나눈 값) */
  minSimilarity: number;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function textChange(field: TextField, before: unknown, after: unknown, rule: RecheckRule): RecheckFieldChange | null {
  const limits = TEXT_RULES[field];
  const a = contentTokens(before), b = contentTokens(after);
  if (a.size < limits.sparse && b.size < limits.sparse) return null;
  if (a.size < limits.sparse) return limits.appearCounts && b.size >= limits.substantial ? { field, kind: "appeared" } : null;
  if (b.size < limits.sparse) return a.size >= limits.substantial ? { field, kind: "vanished" } : null;
  const { similarity, difference } = tokenSimilarity(a, b);
  return similarity < rule.minSimilarity && difference >= limits.minDifference ? { field, kind: "changed", similarity: round(similarity) } : null;
}

/** 주소는 scheme·host 를 소문자로, 끝의 / 와 #조각을 뗀다. 고칠 수 없으면 앞뒤 공백만 뗀 그대로 */
export function normalizedRecheckUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch { return value.trim(); }
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((token) => b.has(token));
const topicSet = (value: unknown) => new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
  .map((item) => item.trim().toLowerCase()).filter(Boolean) : []);

/**
 * 기준(모델이 마지막으로 본 내용)과 지금 내용을 견준다. 기준에 없는 칸은 견주지 않는다. fields 는 바뀐 칸만, 정해진 차례로.
 */
export function compareRecheckContent(baseline: RecheckContent, current: RecheckContent, rule: RecheckRule): RecheckComparison {
  const fields: RecheckFieldChange[] = [];
  const known = (field: RecheckField) => Object.hasOwn(baseline, field) && baseline[field] !== undefined;
  for (const field of RECHECK_FIELDS) {
    if (!known(field)) continue;
    const before = baseline[field], after = current[field];
    let change: RecheckFieldChange | null = null;
    switch (field) {
      case "description": case "pageText": case "readme":
        change = textChange(field, before, after, rule);
        break;
      case "name": {
        const a = contentTokens(before), b = contentTokens(after);
        const same = a.size || b.size ? sameSet(a, b) : String(before ?? "").trim() === String(after ?? "").trim();
        if (!same) change = { field, kind: "changed", similarity: round(tokenSimilarity(a, b).similarity) };
        break;
      }
      case "topics":
        if (!sameSet(topicSet(before), topicSet(after))) change = { field, kind: "changed" };
        break;
      case "url":
        if (normalizedRecheckUrl(before) !== normalizedRecheckUrl(after)) change = { field, kind: "changed" };
        break;
      case "packageProof":
        if (reviewHash(before ?? []) !== reviewHash(after ?? [])) change = { field, kind: "changed" };
        break;
      default:
        if (before !== after) change = { field, kind: "changed" };
    }
    if (change) fields.push(change);
  }
  return { changed: fields.length > 0, fields };
}

/** 항목에 남기는 "무엇이 바뀌어 다시 올렸나"(product_audit_items.change_summary) */
export type RecheckChangeSummary = {
  version: 1;
  fields: RecheckFieldChange[];
  minSimilarity: number;
  baseline: { source: "first_review" | "recheck" | "seeded"; attemptId: number | null; itemId: number | null; judgedAt: string | null };
};

/** 화면에 보일 칸 이름 */
export const RECHECK_FIELD_LABELS: Readonly<Record<RecheckField, string>> = Object.freeze({
  name: "이름", description: "소개", pageText: "페이지 본문", readme: "README", topics: "토픽", url: "주소", accessMode: "쓰는 방식",
  packageProof: "패키지 증거", linksOwnGithub: "제작자 GitHub 링크",
});

/** "본문(유사도 0.32) · 이름" — 화면의 한 줄 */
export function recheckChangeText(summary: unknown): string | null {
  const fields = summary && typeof summary === "object" && Array.isArray((summary as { fields?: unknown }).fields)
    ? (summary as { fields: RecheckFieldChange[] }).fields : null;
  if (!fields?.length) return null;
  return fields.filter((change) => Object.hasOwn(RECHECK_FIELD_LABELS, change.field)).map((change) => {
    const label = RECHECK_FIELD_LABELS[change.field];
    if (change.kind === "appeared") return `${label} 생김`;
    if (change.kind === "vanished") return `${label} 사라짐`;
    return typeof change.similarity === "number" && change.field !== "name" ? `${label}(유사도 ${change.similarity.toFixed(2)})` : label;
  }).join(" · ");
}

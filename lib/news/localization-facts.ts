import { assistHash, validateAssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { buildNewsLocalizationInput, newsLocalizationSourceHash, newsLocalizationSourceSchema,
  type NewsLocalizationIssue, type NewsLocalizationOutcome, type NewsLocalizationSource, type NewsLocalizationValidation } from "./localization-contract";

type Direction = "input" | "output" | "other";
export type NormalizedNewsPrice = Readonly<{ amount: string; currency: "USD" | "EUR" | "GBP";
  perQuantity: string; perUnit: "token" | "request" | "month" | "year"; direction: Direction }>;
const INSTRUCTION = /assistant\s+instruction|system\s+override|admin\s+override|ignore\s+(?:all\s+)?(?:your|previous|reviewer)\s+(?:task|rules?|instructions?)|이전\s*지시를?\s*무시/iu;
const normalize = (value: string) => value.normalize("NFKC").replace(/\u00a0/g, " ").trim();

function factualText(value: string): string {
  return normalize(value).replace(/(?:quoted\s+(?:reader\s+)?comment|reader\s+comment|assistant\s+instruction)[^\n]*?["“][^"”]*["”]/giu, " ")
    .split(/(?<=[.!?。])\s+|\n+/u).filter(clause => !INSTRUCTION.test(clause)).join("\n");
}
function clauses(value: string): string[] {
  return factualText(value).split(/(?<=[.!?。])\s+|\n+|(?<!\d),|,(?!\d)|[;。]|\b(?:and|but)\b|(?:이며|이고|하지만)/iu).map(value => value.trim()).filter(Boolean);
}
function claimClauses(value: string): string[] {
  // and/와로 이어진 목적어의 공통 부정을 끊지 않는다: "training data and code are not available".
  return factualText(value).split(/(?<=[.!?。])\s+|\n+|(?<!\d),|,(?!\d)|[;。]|\bbut\b|하지만/iu).map(value => value.trim()).filter(Boolean);
}
function decimal(value: string): string | null {
  const raw = normalize(value);
  if (!/^\d{1,30}(?:,\d{3})*(?:\.\d{1,12})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.replace(/,/g, "").split(".");
  const integral = whole.replace(/^0+(?=\d)/, ""), tail = fraction.replace(/0+$/, "");
  return tail ? `${integral}.${tail}` : integral;
}
export function normalizeNewsQuantity(value: string): string | null {
  const raw = normalize(value).toLowerCase().replace(/\s+/g, "");
  if (["million", "onemillion", "amillion", "백만"].includes(raw)) return "1000000";
  const match = /^(\d[\d,]*(?:\.\d+)?)(million|m|백만|만|thousand|k|천)?$/.exec(raw);
  if (!match) return null;
  const parsed = decimal(match[1]);
  if (parsed === null) return null;
  const multiplier = ({ million: 1_000_000, m: 1_000_000, 백만: 1_000_000, 만: 10_000,
    thousand: 1000, k: 1000, 천: 1000 } as Record<string, number>)[match[2] ?? ""] ?? 1;
  const [whole, fraction = ""] = parsed.split("."), scale = BigInt(10) ** BigInt(fraction.length);
  const scaled = BigInt(whole + fraction) * BigInt(multiplier);
  return scaled % scale === BigInt(0) ? String(scaled / scale) : null;
}
function currency(value: string): NormalizedNewsPrice["currency"] | null {
  const raw = normalize(value).toLowerCase();
  if (["$", "usd", "dollar", "dollars", "달러"].includes(raw)) return "USD";
  if (["€", "eur", "euro", "euros", "유로"].includes(raw)) return "EUR";
  if (["£", "gbp", "pound", "pounds", "파운드"].includes(raw)) return "GBP";
  return null;
}
function unit(value: string): NormalizedNewsPrice["perUnit"] | null {
  const raw = normalize(value).toLowerCase();
  if (/^(tokens?|토큰)$/.test(raw)) return "token";
  if (/^(requests?|요청)$/.test(raw)) return "request";
  if (/^(months?|월|개월)$/.test(raw)) return "month";
  if (/^(years?|년)$/.test(raw)) return "year";
  return null;
}
function directions(value: string): Direction[] {
  return [...value.matchAll(/\binput\b|\boutput\b|입력|출력/giu)].map(match => /input|입력/iu.test(match[0]) ? "input" : "output");
}
function denominators(value: string): { quantity: string; unit: NormalizedNewsPrice["perUnit"] }[] {
  const found: { quantity: string; unit: NormalizedNewsPrice["perUnit"] }[] = [];
  const quantified = /((?:(?:one|a)\s+)?million|백만|\d[\d,]*(?:\.\d+)?\s*(?:million|thousand|백만|만|천|[mk])?)\s*(?:(?:input|output|입력|출력)\s*)?(tokens?|토큰|requests?|요청|months?|개월|월|years?|년)/giu;
  for (const match of value.matchAll(quantified)) {
    const quantity = normalizeNewsQuantity(match[1]), measuredUnit = unit(match[2]);
    if (quantity && quantity !== "0" && measuredUnit) found.push({ quantity, unit: measuredUnit });
  }
  for (const match of value.matchAll(/(tokens?|토큰|requests?|요청)\s*(백만|\d[\d,]*(?:\.\d+)?\s*(?:million|thousand|백만|만|천|[mk])?)\s*(?:개)?당/giu)) {
    const quantity = normalizeNewsQuantity(match[2]), measuredUnit = unit(match[1]);
    if (quantity && quantity !== "0" && measuredUnit) found.push({ quantity, unit: measuredUnit });
  }
  if (!found.length) for (const match of value.matchAll(/(?:(?:per\s+|\/\s*)(?:(?:input|output)\s*)?(tokens?|requests?|months?|years?)\b)|(토큰|요청|개월|월|년)(?:\s*개)?당/giu)) {
    const measuredUnit = unit(match[1] ?? match[2]);
    if (measuredUnit) found.push({ quantity: "1", unit: measuredUnit });
  }
  return [...new Map(found.map(row => [`${row.quantity}:${row.unit}`, row])).values()];
}
const MONEY_PATTERN = /([$€£]|\bUSD|\bEUR|\bGBP)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(USD|EUR|GBP|dollars?|euros?|pounds?|달러|유로|파운드)/giu;
function monetaryValues(value: string): { amount: string; currency: NormalizedNewsPrice["currency"] }[] {
  return [...value.matchAll(MONEY_PATTERN)]
    .flatMap(match => {
      const amount = decimal(match[2] ?? match[3]), measuredCurrency = currency(match[1] ?? match[4]);
      return amount !== null && measuredCurrency ? [{ amount, currency: measuredCurrency }] : [];
    });
}

/** 지원하는 명시적 가격 형식만 읽는다. 불명확한 표현은 추측하지 않는다. */
export function extractNewsPrices(value: string): { prices: NormalizedNewsPrice[]; unsupported: boolean } {
  const raw = factualText(value), allMoney = monetaryValues(raw), allDenominators = denominators(raw);
  const rows: NormalizedNewsPrice[] = [];
  const currencyCue = /[$€£¥₩]|\b(?:USD|EUR|GBP|JPY|KRW|CNY|RMB|dollars?|euros?|pounds?|yen|yuan|won)\b|\d\s*(?:달러|유로|파운드|엔|원|위안)/iu;
  const unparsedMoney = raw.replace(MONEY_PATTERN, (match: string, prefixCurrency: string | undefined, prefixAmount: string | undefined,
    suffixAmount: string | undefined, suffixCurrency: string | undefined) =>
    decimal(prefixAmount ?? suffixAmount ?? "") !== null && currency(prefixCurrency ?? suffixCurrency ?? "") ? " " : match);
  let unsupported = currencyCue.test(unparsedMoney);
  for (const clause of clauses(raw)) {
    const money = monetaryValues(clause);
    if (!money.length) continue;
    const explicit = denominators(clause);
    const denominator = explicit.length === 1 ? explicit[0]
      : explicit.length === 0 && allDenominators.length === 1 ? allDenominators[0] : null;
    const directionValues = directions(clause), directionSet = [...new Set(directionValues)];
    const paired = money.length === 2 && directionSet.length === 2 && /respectively|각각/iu.test(clause);
    if (!denominator || directionSet.length > 1 && !paired) { unsupported = true; continue; }
    for (const [index, item] of money.entries()) rows.push({ ...item, perQuantity: denominator.quantity,
      perUnit: denominator.unit, direction: paired ? directionSet[index] : directionSet[0] ?? "other" });
  }
  if (rows.length !== allMoney.length) unsupported = true;
  return { prices: rows, unsupported };
}
function normalizedStatePrices(outcome: NewsLocalizationOutcome): NormalizedNewsPrice[] | null {
  const result: NormalizedNewsPrice[] = [];
  for (const price of outcome.state.prices) {
    const amount = decimal(price.amount), measuredCurrency = currency(price.currency), quantity = normalizeNewsQuantity(price.per_quantity), measuredUnit = unit(price.per_unit);
    if (amount === null || !measuredCurrency || !quantity || quantity === "0" || !measuredUnit) return null;
    result.push({ amount, currency: measuredCurrency, perQuantity: quantity, perUnit: measuredUnit, direction: price.direction });
  }
  return result;
}
const priceKey = (price: NormalizedNewsPrice) => JSON.stringify(price);
function samePrices(a: readonly NormalizedNewsPrice[], b: readonly NormalizedNewsPrice[]): boolean {
  const left = a.map(priceKey).sort(), right = b.map(priceKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function dateFacts(value: string, yearHint?: string): { dates: string[]; unsupported: boolean } {
  const dates: string[] = [];
  let unsupported = false, remaining = factualText(value);
  const add = (year: string | undefined, month: string, day: string) => {
    if (!year) { unsupported = true; return; }
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) unsupported = true;
    else dates.push(iso);
  };
  remaining = remaining.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/gu, (_, year: string, month: string, day: string) => { add(year, month, day); return " "; });
  remaining = remaining.replace(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu,
    (_, year: string | undefined, month: string, day: string) => { add(year ?? yearHint, month, day); return " "; });
  remaining = remaining.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/giu,
    (_, month: string, day: string, year: string | undefined) => { add(year ?? yearHint, String(MONTHS.indexOf(month.toLowerCase()) + 1), day); return " "; });
  // 숫자만 있는 지역별 날짜나 축약형은 월/일 순서를 추측하지 않는다.
  if (/\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b|\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}\b/iu.test(remaining)) unsupported = true;
  return { dates: [...new Set(dates)].sort(), unsupported };
}

type Stage = NewsLocalizationOutcome["state"]["release"]["stage"];
type Availability = NewsLocalizationOutcome["state"]["release"]["availability"];
type Scope = NewsLocalizationOutcome["state"]["release"]["scope"][number];
function negated(value: string): boolean {
  return /\b(?:no|not|never|without|hasn't|haven't|doesn't)\b|없|않|아니|미정|미발표|미출시|언급되지|밝히지|발표되지/iu.test(value);
}
function releaseFacts(value: string): { stages: Stage[]; availability: Availability[]; scope: Scope[] } {
  const stages = new Set<Stage>(), availability = new Set<Availability>(), scope = new Set<Scope>();
  const text = factualText(value);
  for (const clause of claimClauses(text)) {
    const negative = negated(clause);
    if (/preview|프리뷰|미리보기/iu.test(clause) && !negative) stages.add("preview");
    if (/\bbeta\b|베타/iu.test(clause) && !negative) stages.add("beta");
    if (/general\s+availability|generally\s+available|정식\s*(?:출시|공개|제공)|일반\s*(?:제공|출시)/iu.test(clause) && !negative
      && !/\b(?:will|plan|expect|future)\b|예정|계획/iu.test(clause)) stages.add("general_availability");
    if (/preprint|preliminary\s+(?:study|research)|research(?:ers?|\s+team)?|예비\s*연구|연구(?:진|팀)|프리프린트|사전\s*(?:인쇄|출판)/iu.test(clause)) stages.add("research");
    if (/postpon|(?:launch|release|availability).{0,60}delay|delayed.{0,60}(?:launch|release)|(?:출시|공개|제공|API).{0,25}(?:연기|지연)|(?:연기|지연).{0,25}(?:출시|공개)/iu.test(clause)) availability.add("delayed");
    if (/\b(?:plans?\s+to|will\s+(?:begin|release|launch|open)|scheduled|expected)\b|예정|계획/iu.test(clause)) availability.add("planned");
    if (/not\s+(?:yet\s+)?available|not\s+available\s+yet|unavailable|현재.*(?:불가|없)|아직.*(?:이용|사용).*(?:없|않|불가)|미출시/iu.test(clause)) availability.add("unavailable");
    if (/\b(?:released|launched|opened|published|available\s+(?:now|today))\b|출시했|공개했|제공했|시작했|이용\s*가능|사용\s*가능/iu.test(clause) && !negative) availability.add("available");
    const scopes: [Scope, RegExp][] = [["api", /\bAPI\b/iu], ["weights", /\bweights\b|가중치/iu],
      ["training_code", /training\s+(?:source\s+)?code|학습\s*코드/iu], ["training_data", /training\s+data|학습\s*데이터/iu],
      ["paper", /\bpaper\b|\bpreprint\b|논문|프리프린트/iu]];
    if (!negative) for (const [kind, pattern] of scopes) if (pattern.test(clause)) scope.add(kind);
  }
  return { stages: [...stages], availability: [...availability], scope: [...scope] };
}
function cappedPercentages(value: string): { amount: string; qualifier: "maximum" | "minimum" }[] {
  const found: { amount: string; qualifier: "maximum" | "minimum" }[] = [];
  for (const match of factualText(value).matchAll(/(up\s+to|at\s+least|최대|최소)\s*(\d+(?:\.\d+)?)\s*(?:%|percent|퍼센트)/giu)) {
    const amount = decimal(match[2]);
    if (amount !== null) found.push({ amount, qualifier: /up\s+to|최대/iu.test(match[1]) ? "maximum" : "minimum" });
  }
  return found;
}
function notReplicated(value: string): boolean {
  return /not\s+(?:yet\s+)?(?:been\s+)?independently\s+(?:replicated|reproduced|verified)|독립.{0,30}(?:재현|검증).{0,20}(?:없|않|되지)|미재현/iu.test(factualText(value));
}
function hasUnclearNegatedRelease(value: string): boolean {
  return claimClauses(value).some(clause => {
    if (!negated(clause)) return false;
    const general = /general\s+availability|generally\s+available|정식\s*(?:출시|공개|제공)/iu.test(clause);
    const disclosure = /training\s+(?:data|code)|학습\s*(?:데이터|코드)/iu.test(clause);
    const explicitNegative = /(?:not|no|without|doesn't|hasn't|haven't).{0,65}(?:available|announced|released|claim|training|general)|(?:availability|release|date).{0,35}(?:not|no)|정식.{0,25}(?:없|않|미정|미발표)|(?:학습.{0,50}(?:공개|제공)).{0,35}(?:않|없|미정|미발표|언급되지|밝히지)/iu.test(clause);
    return (general || disclosure) && !explicitNegative;
  });
}
function positiveFree(value: string): boolean {
  return claimClauses(value).some(clause => /\bfree\b|무료/iu.test(clause) && !negated(clause));
}

/** 유한한 문장 패턴과 고정 사실을 검수한다. 의미 정확도 전반을 보장하거나 게시 권한을 발급하지 않는다. */
export function validateNewsLocalization(value: NewsLocalizationSource, output: unknown, expectedSourceHash?: string): NewsLocalizationValidation {
  const parsedSource = newsLocalizationSourceSchema.safeParse(value);
  if (!parsedSource.success) return { ok: false, disposition: "needs_review", issues: [{ code: "invalid_contract", location: "source" }] };
  const source = parsedSource.data, hash = newsLocalizationSourceHash(source);
  if (source.state === "hidden") return { ok: false, disposition: "needs_review", issues: [{ code: "hidden_source", location: "source" }] };
  if (expectedSourceHash !== undefined && expectedSourceHash !== hash) return { ok: false, disposition: "needs_review", issues: [{ code: "source_changed", location: "source" }] };
  const input = buildNewsLocalizationInput(source), validated = validateAssistOutcome(input, output);
  if (!validated.ok || validated.outcome.task !== "news") return { ok: false, disposition: "needs_review", issues: [{ code: "invalid_contract", location: "state" }] };
  const outcome = validated.outcome;
  if (outcome.action.proposal !== "publish_translation_candidate" || !outcome.state.draft.title || !outcome.state.draft.summary) {
    return { ok: false, disposition: "needs_review", issues: [{ code: "not_a_translation_candidate", location: "state" }] };
  }
  const issues: NewsLocalizationIssue[] = [];
  const original = `${source.title}\n${source.summary ?? ""}`, draft = `${outcome.state.draft.title}\n${outcome.state.draft.summary}`;
  const originalPrices = extractNewsPrices(original), draftPrices = extractNewsPrices(draft), statePrices = normalizedStatePrices(outcome);
  if (originalPrices.unsupported || draftPrices.unsupported) issues.push({ code: "unsupported_price_expression", location: originalPrices.unsupported ? "source" : "draft" });
  if (!statePrices || !samePrices(originalPrices.prices, statePrices)) issues.push({ code: "normalized_price_mismatch", location: "state" });
  if (!samePrices(originalPrices.prices, draftPrices.prices)) issues.push({ code: "draft_price_mismatch", location: "draft" });
  const originalDates = dateFacts(original), years = [...new Set(originalDates.dates.map(date => date.slice(0, 4)))];
  const yearHint = years.length === 1 ? years[0] : undefined, draftDates = dateFacts(draft, yearHint);
  const normalizedDates = outcome.state.dates.map(date => date.iso_date).filter((date): date is string => date !== null);
  if (originalDates.unsupported || draftDates.unsupported) issues.push({ code: "unsupported_date_expression", location: originalDates.unsupported ? "source" : "draft" });
  if (JSON.stringify(originalDates.dates) !== JSON.stringify(draftDates.dates)
    || JSON.stringify(originalDates.dates) !== JSON.stringify([...new Set(normalizedDates)].sort())
    || outcome.state.dates.some(date => !factualText(original).includes(date.original)
      || date.iso_date === null || !dateFacts(date.original, yearHint).dates.includes(date.iso_date))) {
    issues.push({ code: "date_mismatch", location: "draft" });
  }
  if (outcome.evidence.some(item => INSTRUCTION.test(item.quote))) issues.push({ code: "instruction_as_fact", location: "evidence" });
  if (outcome.state.names.some(name => !factualText(original).includes(name.original))) issues.push({ code: "normalized_name_missing", location: "state" });
  const from = releaseFacts(original), to = releaseFacts(draft), release = outcome.state.release;
  if (hasUnclearNegatedRelease(original) || hasUnclearNegatedRelease(draft)) issues.push({ code: "unsupported_release_expression", location: "draft" });
  if (positiveFree(draft) && !positiveFree(original)) issues.push({ code: "unsupported_free_claim", location: "draft" });
  if (outcome.state.prices.some(price => price.effective_status === "current" && !from.availability.includes("available")
    || price.effective_status === "planned" && !from.availability.some(status => ["planned", "delayed", "unavailable"].includes(status)))) {
    issues.push({ code: "normalized_price_mismatch", location: "state" });
  }
  if (release.stage !== "unknown" && !from.stages.includes(release.stage)
    || to.stages.some(stage => !from.stages.includes(stage))
    || from.stages.some(stage => ["preview", "beta"].includes(stage) && !to.stages.includes(stage))) issues.push({ code: "release_stage_mismatch", location: "draft" });
  if (release.availability !== "unknown" && !from.availability.includes(release.availability)
    || to.availability.some(status => !from.availability.includes(status))
    || from.availability.includes("delayed") && !to.availability.includes("delayed")
    || from.availability.includes("planned") && !to.availability.some(status => ["planned", "delayed", "unavailable"].includes(status))) issues.push({ code: "availability_mismatch", location: "draft" });
  if (release.scope.some(kind => kind !== "unknown" && kind !== "product" && !from.scope.includes(kind))
    || to.scope.some(kind => !from.scope.includes(kind))) issues.push({ code: "release_scope_mismatch", location: "draft" });
  const caps = cappedPercentages(original), draftCaps = cappedPercentages(draft);
  if (caps.some(cap => !draftCaps.some(candidate => candidate.amount === cap.amount && candidate.qualifier === cap.qualifier))
    || notReplicated(original) && !notReplicated(draft)) issues.push({ code: "qualification_lost", location: "draft" });
  if (notReplicated(original) && claimClauses(draft).some(clause => /입증|검증(?:됐|되었|했)|재현(?:됐|되었|했)|independently\s+(?:verified|replicated|reproduced)/iu.test(clause) && !negated(clause))) {
    issues.push({ code: "unsupported_confirmation", location: "draft" });
  }
  if (issues.length) return { ok: false, disposition: "needs_review", issues: [...new Map(issues.map(issue => [`${issue.code}:${issue.location}`, issue])).values()] };
  return { ok: true, sourceHash: hash, title: outcome.state.draft.title, summary: outcome.state.draft.summary,
    factsHash: assistHash(outcome.state), semanticCoverage: "bounded_patterns", authority: "translation_candidate_only" };
}

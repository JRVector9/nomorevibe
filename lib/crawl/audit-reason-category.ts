/**
 * 감사 사유의 갈래 — 공개분 감사(product-audit)에서 모델이 "제품 아님"·"보류"라고 한 까닭을 사람이 한눈에 묶어 보게 한다.
 *
 * 모델은 사유를 영어 문장으로만 돌려준다(코드 칸이 없다). 심사 글을 바꿔 코드를 받으면 진행 중인 감사가 멈추므로
 * (auditCampaignStalled), 글은 그대로 두고 문장의 낱말로 나눈다. 판단을 바꾸지 않고 보여 주기만 하므로 틀려도 해가 작다 —
 * 맞지 않는 것은 '기타'로 남는다. 차례가 곧 우선순위다: 로그인 창만 있는 쇼핑몰은 '로그인 화면만'이다.
 *
 * 2026-10-11 감사 #3 미처리 1,416건으로 낱말을 맞췄다.
 */
export const AUDIT_REASON_CATEGORIES = {
  login: { label: "로그인 화면만", hint: "로그인·비밀번호 창만 있고 무엇인지 알 수 없다" },
  placeholder: { label: "빈 화면·오류·준비 중", hint: "제목만·로딩·오류·배포 없음·준비 중·대기자 명단" },
  platform: { label: "남의 플랫폼·목록 페이지", hint: "패키지 저장소·도커 허브·메신저·결제창·여러 도구를 모은 목록 사이트" },
  shop: { label: "쇼핑몰·판매", hint: "물건을 파는 가게·카탈로그" },
  content: { label: "글·문서·강의", hint: "블로그·기사·문서·노트·팟캐스트·강의" },
  company: { label: "회사·서비스 소개", hint: "회사·단체·대행·컨설팅·오프라인 서비스 소개" },
  other: { label: "기타", hint: "위 갈래에 들지 않는 사유" },
} as const;

export type AuditReasonCategory = keyof typeof AUDIT_REASON_CATEGORIES;
export const AUDIT_REASON_KEYS = Object.keys(AUDIT_REASON_CATEGORIES) as AuditReasonCategory[];

/**
 * 위에서부터 처음 맞는 갈래. 낱말 경계(\b)로 'shopping' 같은 이웃 낱말을 막는다.
 * SQL 도 이 글로 같은 갈래를 가른다(audit-second-opinions.ts auditReasonCategorySql — \b 를 Postgres 의 \y 로만 바꾼다)
 */
export const AUDIT_REASON_RULES: readonly (readonly [Exclude<AuditReasonCategory, "other">, RegExp])[] = [
  ["login", /\b(log[- ]?in|sign[- ]?in|password|credentials?|authentication (?:screen|page|wall)|access portal)\b/],
  ["placeholder", /\b(placeholder|coming soon|waitlist|wait list|loading\.{0,3}|under construction|blank page|empty page|(?:page ?text|readme) (?:is|are) empty|no (?:visible )?page ?text|only (?:shows|contains|displays|has)? ?(?:a |the )?(?:title|styling|css|javascript bundle|error)|shows only (?:a |the )?(?:title|styling|error)|enable javascript|javascript bundle|styling (?:code|content)|deployment[_ ]not[_ ]found|deployment could not be found|404|not found|error (?:page|message|spinner)|no visible (?:content|ui|interface|description)|health ?check|parked domain|default (?:template|page)|starter template|boilerplate|update available)\b/],
  ["platform", /\b(nuget|npm(?:js)?|pypi|crates\.io|rubygems|maven|docker hub|package registr(?:y|ies)|app store listing|play store listing|telegram|discord|whatsapp group|t\.me|accounts\.google|checkout\.stripe|stripe (?:payment|checkout)|buy me a coffee|ko-fi|patreon|product hunt|third[- ]party (?:platform|site|service|listing)|listing site|directory(?:\/benchmark)? (?:site|listing|page)|curated directory|catalog of (?:tools|services|links)|aggregat(?:es|or|ing)|resource catalog|hosting provider|marketplace listing|github (?:profile|repository) page|gumroad|boosty|copr|video (?:hosting|platform)|youtube|bilibili|vimeo|marketplace (?:page|listing)|catalog\/benchmark|landscape page|lists many|curation platform|prompt library)\b/],
  ["shop", /\b(e-?commerce|storefront|online (?:store|shop)|e-?shop|shop(?:ping)? (?:site|cart)|sells? (?:clothing|products|goods|items|accessories|hardware|furniture|jewel+ery|food|coffee)|retail(?:er)? site|product catalog(?:ue)?|sells? (?:physical |digital )?goods|selling (?:\w+ ){0,2}(?:goods|items|products)|sales page|marketplace selling)\b/],
  ["content", /\b(article|blog|weblog|post|news(?:letter)?|documentation|docs site|manual|notes|essay|podcast|episode|video|course|curriculum|tutorial|lesson|training program|research (?:paper|report|weblog|archive|description)|analysis (?:notes|reports?)|commentary|handbook|textbooks?|e-?book|lectures?|wiki|recipe|guide (?:site|page)|travel guide|informational site|archive|portfolio of (?:articles|writing)|content site)\b/],
  ["company", /\b(company|corporate|business|agency|consult(?:ing|ancy|ants?)|services? (?:site|business|company|provider)|offers? (?:\w+ ){0,3}services|marketing (?:site|copy|page)|commercial (?:service|landing)|service offering|membership service|service marketplace|sells (?:\w+ ){0,2}services|promotional (?:site|page|landing)|organi[sz]ation|non-?profit|charity|foundation|studio|firm|clinic|restaurant|caf[eé]|hotel|rental|real estate|venue|gym|school|church|event|invitation|rsvp|wedding|community|team site|club|band)\b/],
];

/** 사유 한 줄의 갈래. 사유가 없으면 '기타' */
export function classifyAuditReason(reason: string | null | undefined): AuditReasonCategory {
  if (!reason) return "other";
  // 모델이 쓰는 줄 바꿈 없는 하이픈(U+2011)·긴 하이픈을 보통 하이픈으로
  const text = reason.toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  return AUDIT_REASON_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

/** 갈래마다 몇 건이고 어느 항목인지 — 화면의 칩 수와 거르기가 같은 셈을 쓴다 */
export function groupAuditReasons(rows: { id: number; reason: string | null }[]) {
  const ids = Object.fromEntries(AUDIT_REASON_KEYS.map((key) => [key, [] as number[]])) as Record<AuditReasonCategory, number[]>;
  for (const row of rows) ids[classifyAuditReason(row.reason)].push(row.id);
  return ids;
}

export function isAuditReasonCategory(value: unknown): value is AuditReasonCategory {
  return typeof value === "string" && Object.hasOwn(AUDIT_REASON_CATEGORIES, value);
}

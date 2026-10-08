/**
 * 저장 바가 보여 줄 "무엇이 바뀌었나" — 처음 그린 폼 값과 지금 폼 값을 견준다.
 *
 * 폼은 손대지 않은(uncontrolled) 입력이 대부분이라 값을 상태로 들고 있지 않다. 그래서 FormData 를
 * 두 번 떠서 비교한다. 체크박스는 꺼지면 값이 빠지므로 없는 키는 "끔"으로 읽는다.
 */
export type FieldValues = Record<string, string>;

/** 폼 → 이름별 값. 같은 이름이 여럿이면 줄바꿈으로 잇는다 */
export function formValues(form: HTMLFormElement): FieldValues {
  const values: FieldValues = {};
  for (const [key, value] of new FormData(form).entries()) {
    const text = typeof value === "string" ? value : value.name;
    values[key] = key in values ? `${values[key]}\n${text}` : text;
  }
  return values;
}

const SCALARS: Record<string, string> = {
  enabled: "수집",
  windowDays: "최근 며칠",
  sort: "정렬",
  pagesPerTick: "틱당 페이지",
  autoApproveMinStars: "자동 승인 최소 스타",
  minStars: "스타 하한",
  maxPushAgeDays: "방치 기준",
  excludeForks: "포크 제외",
  excludeOrganizations: "조직 계정 제외",
  holdAmbiguous: "애매하면 보류",
  agentEvidenceEnabled: "개발 AI 근거 수집",
  agentEvidenceEnforce: "근거를 발행 조건으로",
  firstReviewProvider: "1차 심사 부르는 곳",
  firstReviewModel: "1차 심사 모델",
  reviewConcurrency: "동시 실행 수",
  secondReviewEnabled: "2차 심사",
  secondReviewSamplePercent: "공개분 표본",
  secondReviewAgreeAt: "일치 기준 확신",
  secondReviewIncludeAiHeld: "1차 AI도 못 가른 것",
  "showHn.enabled": "Show HN",
  "showHn.priority": "Show HN 우선순위",
  "showHn.requireEvidence": "Show HN AI 흔적",
  risingFreshDays: "지금 뜨는 확인 기간(일)",
};

const LISTS: Record<string, string> = {
  blockedHomepageDomains: "차단 도메인",
  thirdPartyHosts: "남의 사이트",
  stubPageTitles: "빈 페이지 제목",
  excludedRepoPatterns: "레포명 제외",
  heldRepoPatterns: "레포명 보류",
};

const SORTS: Record<string, string> = { recent: "최신 활동순", relevance: "관련도" };
const PROVIDERS: Record<string, string> = { abcllm: "사내 게이트웨이", "claude-cli": "Claude CLI", "grok-cli": "Grok CLI" };

const CHECKBOXES = new Set(["enabled", "excludeForks", "excludeOrganizations", "holdAmbiguous", "agentEvidenceEnabled",
  "agentEvidenceEnforce", "secondReviewEnabled", "secondReviewIncludeAiHeld", "showHn.enabled", "showHn.requireEvidence"]);

function shown(key: string, value: string | undefined): string {
  if (CHECKBOXES.has(key)) return value === "on" ? "켬" : "끔";
  if (key === "sort") return SORTS[value ?? ""] ?? value ?? "";
  if (key === "firstReviewProvider") return PROVIDERS[value ?? ""] ?? value ?? "";
  return value?.trim() ? value.trim() : "비움";
}

const items = (value: string | undefined) => (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

/** 바뀐 것을 사람이 읽는 문장으로 — 화면 순서대로 */
export function describeChanges(before: FieldValues, after: FieldValues): string[] {
  const changes: string[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const differs = (key: string) => (before[key] ?? "") !== (after[key] ?? "");

  if (differs("enabled")) changes.push(`수집 ${shown("enabled", before.enabled)} → ${shown("enabled", after.enabled)}`);
  // 신호는 행 단위라 한 줄로 — 무엇이 바뀌었는지는 표가 보여 준다
  if (keys.some((key) => (key.startsWith("query.") || key.startsWith("showHn.") || key === "queryCount") && differs(key))) {
    const added = (rows: FieldValues) => Object.keys(rows).filter((key) => /^query\.\d+\.label$/.test(key) && rows[key].trim()).length;
    const delta = added(after) - added(before);
    changes.push(delta > 0 ? `검색 신호 +${delta}` : delta < 0 ? `검색 신호 ${delta}` : "검색 신호");
  }
  for (const key of Object.keys(SCALARS)) {
    if (key === "enabled" || key.startsWith("showHn.") || !differs(key)) continue;
    changes.push(`${SCALARS[key]} ${shown(key, before[key])} → ${shown(key, after[key])}`);
  }
  for (const [key, label] of Object.entries(LISTS)) {
    if (!differs(key)) continue;
    const was = new Set(items(before[key])), now = new Set(items(after[key]));
    const plus = [...now].filter((item) => !was.has(item)).length;
    const minus = [...was].filter((item) => !now.has(item)).length;
    changes.push(`${label}${plus ? ` +${plus}` : ""}${minus ? ` −${minus}` : ""}`);
  }
  if (keys.some((key) => /^(voter|fallback)(Provider|Model)\d$/.test(key) && differs(key))) changes.push("2차 심사 모델");
  return changes;
}

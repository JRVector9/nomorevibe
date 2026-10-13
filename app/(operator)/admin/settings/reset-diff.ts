/**
 * 기본값 되돌리기 확인 창에 보일 "바뀔 값" — resetChanges(경로마다 전과 후)를 사람이 읽는 줄로(2026-10-08 UX 감사 ADM-06).
 *
 * 목록은 개수와 더하고 빠지는 것을, 켜고 끄는 값은 켬/끔을 보인다. 카테고리 기준·AI 소식처럼 값이 수십 개로 갈라지는 묶음은
 * 한 줄로 접는다. 이름을 모르는 경로는 경로 그대로 보인다 — 숨기면 무엇이 되돌아가는지 모르고 누르게 된다.
 */
export type SettingChange = { path: string; before: unknown; after: unknown };
export type ResetLine = { label: string; before: string; after: string; note?: string };

const LABELS: Record<string, string> = {
  "discover.queries": "검색 신호",
  "discover.windowDays": "최근 며칠",
  "discover.sort": "검색 정렬",
  "discover.pagesPerTick": "틱당 페이지",
  "discover.showHn.enabled": "Show HN 수집",
  "discover.showHn.priority": "Show HN 우선순위",
  "discover.showHn.requireEvidence": "Show HN AI 흔적",
  "judge.autoApproveMinStars": "자동 승인 최소 스타",
  "judge.minStars": "스타 하한",
  "judge.maxPushAgeDays": "방치 기준(일)",
  "judge.excludeForks": "포크 제외",
  "judge.excludeOrganizations": "조직 계정 제외",
  "judge.holdAmbiguous": "애매하면 보류",
  "judge.blockedHomepageDomains": "차단 도메인",
  "judge.thirdPartyHosts": "남의 사이트",
  "judge.stubPageTitles": "빈 페이지 제목",
  "judge.excludedRepoPatterns": "레포명 제외",
  "judge.heldRepoPatterns": "레포명 보류",
  "judge.profileRepoPatterns": "개인 프로필 패턴",
  "judge.profileOnlyPatterns": "분류 확인이 필요한 패턴",
  "judge.personalSiteKeywords": "개인 프로필 키워드",
  "judge.docsGenerators": "문서 생성기",
  "judge.placeholderTitles": "스캐폴드 제목",
  "judge.docsTitlePatterns": "문서 제목 패턴",
  firstReview: "1차 심사 모델",
  reviewConcurrency: "1차 심사 동시 실행 수",
  "secondReview.enabled": "2차 심사",
  "secondReview.voters": "2차 심사 모델",
  "secondReview.fallbacks": "2차 실패 시 대체",
  "secondReview.sampleRate": "2차 공개분 표본",
  "secondReview.agreeAt": "2차 일치 기준 확신",
  "secondReview.includeAiHeld": "1차 AI도 못 가른 것까지",
  "agentEvidence.enabled": "개발 AI 근거 수집",
  "agentEvidence.enforceEligibility": "근거를 발행 조건으로 사용",
  "rising.freshDays": "지금 뜨는 확인 기간(일)",
};

/** 값이 수십 갈래로 나뉘는 묶음 — 한 줄로 접는다 */
const GROUPS: Record<string, string> = { classify: "카테고리 기준", news: "AI 소식" };

/** 목록 항목의 이름 — 신호는 이름, 모델은 모델명 */
function itemName(item: unknown): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    return String(record.label ?? record.model ?? JSON.stringify(item));
  }
  return String(item);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "없음";
  if (typeof value === "boolean") return value ? "켬" : "끔";
  if (Array.isArray(value)) return `${value.length}개`;
  if (typeof value === "object") return itemName(value);
  return String(value);
}

const preview = (items: string[]) => (items.length > 3 ? `${items.slice(0, 3).join(", ")} 외 ${items.length - 3}개` : items.join(", "));

function line(change: SettingChange): ResetLine {
  const label = LABELS[change.path] ?? change.path;
  if (Array.isArray(change.before) || Array.isArray(change.after)) {
    const before = (Array.isArray(change.before) ? change.before : []).map(itemName);
    const after = (Array.isArray(change.after) ? change.after : []).map(itemName);
    const added = after.filter((item) => !before.includes(item));
    const removed = before.filter((item) => !after.includes(item));
    const note = [added.length ? `더함 ${preview(added)}` : "", removed.length ? `빠짐 ${preview(removed)}` : ""].filter(Boolean).join(" · ");
    return { label, before: `${before.length}개`, after: `${after.length}개`, note: note || "순서·세부 값이 바뀝니다" };
  }
  return { label, before: scalar(change.before), after: scalar(change.after) };
}

export function describeReset(changes: readonly SettingChange[]): ResetLine[] {
  const lines: ResetLine[] = [];
  const grouped = new Map<string, number>();
  for (const change of changes) {
    const group = Object.keys(GROUPS).find((key) => change.path === key || change.path.startsWith(`${key}.`));
    if (group) grouped.set(group, (grouped.get(group) ?? 0) + 1);
    else lines.push(line(change));
  }
  for (const [group, count] of grouped) lines.push({ label: GROUPS[group], before: `바꾼 값 ${count}곳`, after: "기본값" });
  return lines;
}

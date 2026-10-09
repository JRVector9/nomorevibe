/**
 * AI 제작 근거 단계의 이름과 홈 필터(2026-10-10 운영자 결정) — 판정은 ai-level.ts, 저장은 repository_ai_levels·products.ai_level(0063).
 *
 * 1 AI 에이전트 앱이 연 PR 이 기본 브랜치에 병합 — PR 을 연 계정은 GitHub 이 기록하고, 서비스가 쥔 앱 토큰 없이는 그 계정으로 열 수 없다.
 * 2 코드를 바꾼 커밋에 AI 도구 서명(Co-authored-by)·작성자 표기 — 저장소가 밝힌 것이라 꾸밀 수 있다.
 * 3 AI 도구 전용 설정·규칙 파일 — 그 도구를 쓰도록 설정했다는 뜻까지다.
 * 근거를 보여 주는 링크는 공개 화면에 내지 않는다(단계 이름만). 'AI 제작 검증' 같은 말은 어느 단계에도 쓰지 않는다.
 *
 * 브라우저에서도 읽는다 — 서버 모듈을 가져오지 않는다.
 */
export type AiLevel = 1 | 2 | 3;

/** 판정 규칙의 판 — 올리면 ai-level-refresh 가 모든 저장소를 다시 본다(그동안 지난 판의 단계는 그대로 보인다) */
export const AI_LEVEL_RULES_VERSION = "2026-10-10.1";

export const AI_LEVELS: readonly AiLevel[] = [1, 2, 3];

export const AI_LEVEL_LABELS: Record<AiLevel, { short: string; title: string; description: string }> = {
  1: {
    short: "AI 에이전트 PR",
    title: "AI 에이전트가 연 PR 병합",
    description: "AI 에이전트 서비스가 연 PR 이 기본 브랜치에 병합됐습니다. PR 을 연 계정은 GitHub 이 기록합니다.",
  },
  2: {
    short: "AI 도구 커밋",
    title: "AI 도구 서명이 있는 개발 커밋",
    description: "코드를 바꾼 커밋에 AI 코딩 도구의 서명이나 작성자 표기가 있습니다. 저장소가 밝힌 것이라 실제 실행을 증명하지는 않습니다.",
  },
  3: {
    short: "AI 도구 설정",
    title: "AI 도구 전용 설정 파일",
    description: "저장소에 AI 코딩 도구 전용 설정·규칙 파일이 있습니다. 그 도구를 쓰도록 설정했다는 뜻입니다.",
  },
};

/** 단계를 세운 근거 몇 건 — 관리자·검증용. 공개 화면은 단계 이름만 쓴다 */
export type AiLevelEvidence = {
  /** 1단계: 에이전트 앱이 열어 기본 브랜치에 병합된 PR(코드 파일을 바꾼 것). claude[bot] 은 2단계 근거로 여기 남는다 */
  pullRequests?: { number: number; agent: string; mergedAt: string; level: AiLevel }[];
  /** 2단계: AI 도구 서명·작성자 표기가 있는 개발 커밋. basis scan 은 기존 근거 수집(agent_repository_observations)에서 온 것 */
  commits?: { sha: string; client: string; basis: "coauthor" | "author" | "footer" | "scan" }[];
  /** 3단계: 루트의 AI 도구 전용 파일 */
  files?: { path: string; client: string }[];
  /** 확인했지만 코드 파일을 바꾸지 않은 에이전트 PR·표기 커밋 — 다시 묻지 않으려고 남긴다(잡 내부용) */
  nonDevelopment?: { pullRequests: number[]; commits: string[] };
};

/** 홈 필터 — made 'AI로 제작'(1·2단계), config 'AI 도구 설정'(3단계만). 주소는 ?ai=made|config */
export type AiFilter = "made" | "config";
export const AI_FILTERS: readonly AiFilter[] = ["made", "config"];
export const AI_FILTER_LEVELS: Record<AiFilter, readonly AiLevel[]> = { made: [1, 2], config: [3] };
export const AI_FILTER_LABELS: Record<AiFilter, string> = { made: "AI로 제작", config: "AI 도구 설정" };

export function parseAiFilter(value: string | null | undefined): AiFilter | null {
  const key = value?.trim().toLowerCase();
  return key === "made" || key === "config" ? key : null;
}

export function isAiLevel(value: unknown): value is AiLevel {
  return value === 1 || value === 2 || value === 3;
}

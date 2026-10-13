import type { MessageKey, MessageSchemas, Translator } from "@/lib/i18n/messages";

/** Status state stores a semantic key, never a locale-specific response string. */
export type DetailTextKey = {
  [Key in MessageKey<"detail">]: MessageSchemas["detail"][Key] extends `${string}{${string}` ? never : Key;
}[MessageKey<"detail">];

export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Bounded adapter for legacy domain presentation labels; unknown source data stays raw. */
const LEGACY_DETAIL_LABELS: Record<string, DetailTextKey> = {
  "공식 출처에서 확인": "source.official", "GitHub에서 확인": "source.github",
  "메이커 제공": "source.makerReported", "메이커 제공·미검증": "source.maker",
  "자동 감지": "source.detected", "저장소 근거": "source.repository",
  "nomorevibe 기록": "source.recorded", "NoMoreVibe 기록": "source.recorded",
  "서명된 빌드 증명": "source.signed", "서명된 빌드": "source.signed",
  "출처 응답 확인·관계 미확인": "source.response",
  "Claude 호환 지침 파일 확인": "tools.observation.claude",
  "에이전트 지침 파일 확인": "tools.observation.instruction",
  "자동 모델 선택 설정": "tools.observation.auto", "모델 설정 확인": "tools.observation.model",
  "도구 설정 확인": "tools.observation.client", "커밋 도구 표기 확인": "tools.observation.committer",
  "커밋 기여 표기 확인": "tools.observation.contributor", "저장소 작성자 사용 주장": "tools.observation.claim",
  "최근 수집 실패 · 이전 확인 정보": "tools.coverage.failed", "일부 미확인": "tools.coverage.partial",
  "에이전트 정보 재확인 필요": "tools.coverage.stale",
  "제품과 저장소 관계 충돌": "tools.relationship.conflict", "제품과 저장소 관계 미확인": "tools.relationship.unknown",
};
export function translatedDetailLabel(value: string, t: Translator<"detail">): string {
  const key = LEGACY_DETAIL_LABELS[value];
  return key ? t(key) : value;
}

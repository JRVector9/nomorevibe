export function emptySearchHealth() {
  return { total: 0, missing: 0, oldMissing: 0, mismatched: 0, unmarked: 0, copiesMismatched: 0,
    pendingGeneration: 0, pendingVerification: 0, oldestVerificationMinutes: 0,
    repeatedFailures: 0, exhausted: 0, generatedRecent: 0, verifiedRecent: 0, generationIdleMinutes: 0 };
}
export type SearchHealth = ReturnType<typeof emptySearchHealth>;
export type SearchHealthAlert = { key: string; tone: "critical" | "hold"; count: number; title: string; detail: string };
export function searchHealthAlerts(c: SearchHealth): SearchHealthAlert[] {
  const alerts: SearchHealthAlert[] = [];
  const add = (key: string, count: number, title: string, detail: string, tone: "critical" | "hold" = "critical") => {
    if (count > 0) alerts.push({ key, count, title, detail, tone });
  };
  add("hash", c.unmarked, "갱신 큐에 없는 검색 해시 불일치", "원본과 생성 입력이 다릅니다. 프로필 복구 점검이 필요합니다.");
  add("copies", c.copiesMismatched, "검색 키워드 사본 불일치", "생성·검수 결과와 실제 검색 데이터가 다릅니다.");
  add("missing", c.oldMissing, "검색 프로필이 오래 누락된 제품", "공개 후 30분이 지났지만 프로필이 없습니다.");
  add("exhausted", c.exhausted, "검색 생성·검수 재시도 한도 도달", "자동 재시도가 멈춘 제품입니다. 오류 원인을 확인하세요.");
  add("repeated", c.repeatedFailures, "검색 생성·검수 반복 실패", "현재 오류가 남아 있고 실패 횟수가 3회 이상입니다.", "hold");
  if (c.generationIdleMinutes >= 30) add("generation-stalled", c.pendingGeneration,
    "검색 프로필 갱신이 진행되지 않습니다", "대기가 남아 있는데 30분 이상 갱신 진행을 관측하지 못했습니다.", "hold");
  if (c.pendingVerification > 0 && c.oldestVerificationMinutes >= 30) {
    add("verification-wait", c.pendingVerification, "검색 키워드 검수가 지연됩니다",
      `가장 오래된 미검수 프로필은 생성 후 ${Math.floor(c.oldestVerificationMinutes)}분입니다. 재시도 대기도 포함합니다.`, "hold");
  }
  return alerts;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function readSearchHealth(observation: unknown, now = Date.now()): SearchHealth | null {
  if (!object(observation) || typeof observation.observedAt !== "string" || !object(observation.value)) return null;
  const age = now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 45 * 60_000 || !Array.isArray(observation.value.events)) return null;
  const event = observation.value.events.find(e => object(e) && e.event === "search_health.checked");
  if (!object(event) || !object(event.counts)) return null;
  const result = emptySearchHealth();
  for (const key of Object.keys(result) as (keyof SearchHealth)[]) {
    const value = event.counts[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    result[key] = value;
  }
  return result;
}

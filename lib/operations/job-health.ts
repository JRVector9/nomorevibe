import { catalogJobsForBatch } from "@/lib/jobs/batches";
import { isPausedJob } from "@/lib/jobs/status";

/**
 * 작업이 정말 성공하고 있나 — "돌았다(lastRunAt)"와 "제 일을 했다(lastSuccessAt)"를 가른다.
 *
 * 2026-10-22 점검: 처리기가 실패를 잡고 그냥 돌아오면 러너가 성공으로 적어(HN·Bluesky 검색 실패, 키 없는 번역, 서버 없는 임베딩,
 * 인증이 끊긴 소개 검수, 광역 실패로 보류한 생존 확인 …) 운영센터가 초록이었다. 이제 처리기는 그런 틱을 degraded 로 돌려주고
 * (lib/jobs/runner.ts JobDegraded), 러너는 성공 시각을 옮기지 않고 job:<name> 관측에 까닭·연속 횟수를 남긴다.
 * 여기서 그 둘을 읽어 조치할 일을 세운다. 던진 실패(lastError)는 이미 "마지막 회차가 실패한 작업"(긴급)이 맡으므로 빼고 본다.
 *
 * 기준(잡 주기 I 에서 나온다 — 주기가 다른 잡을 한 숫자로 재지 않는다):
 * - 성공이 끊김(stale): 마지막 진짜 성공이 max(6·I, 30분)보다 오래면 보류, 그 4배(max(24·I, 2시간))면 긴급.
 *   6주기 — 한두 번 놓친 틱(배포 재시작·30초 재시도·모델 자리 미룸)은 넘기고, 같은 일을 여섯 번 연달아 못 했을 때만 사람을 부른다.
 *   30분 바닥 — 1분 잡이 6분 만에 울리지 않게. maintenance 는 한 번에 한 잡씩이라 집계가 10분까지 줄을 잡고, 배포·역할 인계도 몇 분이다.
 *   이 바닥은 단계 정체 경보(worker-progress.ts upstream_stalled 30분)와 같다.
 * - 연속으로 제 일 못 함(degraded): 연속 max(2, ⌈30분 / I⌉)번이면 보류, 그 4배면 긴급. 못 했다는 증거가 있으니 성공 끊김보다 빨리 —
 *   한 번은 일시적일 수 있어 적어도 두 번, 짧은 잡은 30분어치. 2시간 잡(Bluesky)은 두 번(2~4시간), 1분 잡은 30번(30분)이다.
 * - 처리기가 critical 로 돌려준 것(자격 거절처럼 기다려도 풀리지 않는 것)은 한 번이면 긴급이다.
 * 보류에서 긴급까지 4배는 모든 새 경보(랭킹·Qwen 물러나기·단계 정체)에 같게 쓴다.
 *
 * 성공이 끊겨도 보지 않는 것: 주기가 없는 잡(요청으로만 돈다 — 랭킹은 attention 에서 따로), 지금 batch 에서 돌지 않는 잡,
 * 사람이 멈춘 잡, 던진 실패가 있는 잡, 한 번도 돌지 않은 잡(스케줄러·워커 경보가 맡는다), 워커·스케줄러 관측이 끊긴 역할의 잡(같은 까닭),
 * 그리고 마지막 성공 뒤 일부러 미룬 잡(stage_blocked — 단계가 item 소비자로 넘어감, source_buffer·batch_blocked — 사람이 건 조절).
 */
export const JOB_HEALTH_FLOOR_MS = 30 * 60_000;
export const JOB_STALE_INTERVALS = 6;
export const JOB_ESCALATE_FACTOR = 4;
/** 일부러 미룬 것 — 성공이 끊겨도 고장이 아니다 */
export const DELIBERATE_DEFERRALS: ReadonlySet<string> = new Set(["stage_blocked", "source_buffer", "batch_blocked"]);

export function jobHealthThresholds(intervalMs: number) {
  const staleHoldMs = Math.max(JOB_STALE_INTERVALS * intervalMs, JOB_HEALTH_FLOOR_MS);
  const degradedHoldRuns = Math.max(2, Math.ceil(JOB_HEALTH_FLOOR_MS / intervalMs));
  return { staleHoldMs, staleCriticalMs: staleHoldMs * JOB_ESCALATE_FACTOR, degradedHoldRuns, degradedCriticalRuns: degradedHoldRuns * JOB_ESCALATE_FACTOR };
}

export type JobDegradedRecord = { code: string; detail: string | null; critical: boolean; at: string; streak: number; since: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function degradedRecord(value: unknown): JobDegradedRecord | null {
  if (!record(value) || typeof value.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)) return null;
  const at = iso(value.at), since = iso(value.since) ?? at;
  if (!at || !since) return null;
  const streak = typeof value.streak === "number" && Number.isFinite(value.streak) && value.streak >= 1 ? Math.floor(value.streak) : 1;
  return { code: value.code, detail: typeof value.detail === "string" && value.detail ? value.detail.slice(0, 300) : null,
    critical: value.critical === true, at, streak, since };
}

/** job:<name> 관측 값에서 지금 이어지는 제 일 못 함(current)과 끊기기 전 마지막 것(last) */
export function readJobDegraded(value: unknown): { current: JobDegradedRecord | null; last: JobDegradedRecord | null } {
  if (!record(value)) return { current: null, last: null };
  const current = degradedRecord(value.degraded);
  return { current, last: current ?? degradedRecord(value.lastDegraded) };
}

export type JobHealthState = {
  name: string; lastRunAt: Date | null; lastSuccessAt: Date | null; lastError: string | null; notBefore: Date | null; runs: number;
};
export type JobHealthIssue = {
  job: string; level: "hold" | "critical";
  /** degraded: 제 일 못 한 틱이 이어진다 · stale: 진짜 성공이 끊겼다(미룸·잠김 등 까닭 모름 포함) */
  kind: "degraded" | "stale";
  degraded: JobDegradedRecord | null;
  lastSuccessAt: string | null;
  /** 진짜 성공이 끊긴 시간(ms) — 성공한 적이 없으면 null */
  sinceSuccessMs: number | null;
  /** 마지막 성공 뒤 미룬 까닭(defer:<job>) — 있으면 */
  deferral: { reason: string; at: string } | null;
};

export type JobHealthInput = {
  jobs: readonly JobHealthState[];
  /** job:<name> 관측(operationsData().observations) */
  observations: readonly { key: string; value: unknown }[];
  /** 마지막으로 미룬 까닭 — 못 읽었으면 null(그때는 까닭 모를 성공 끊김을 경보하지 않는다: 일부러 미룬 잡을 고장으로 부를 수 있다) */
  deferrals: ReadonlyMap<string, { reason: string; at: string }> | null;
  batch: { mode: string; writerContractVersion: number };
  /** 워커 관측이 끊긴 역할 — 그 역할의 잡은 생존 경보가 먼저 말한다 */
  silentRoles?: ReadonlySet<string>;
  now: Date;
};

/** 성공이 끊겼거나 제 일 못 한 틱이 이어지는 잡 — 긴급이 먼저, 그다음 오래된 순 */
export function jobHealthIssues(input: JobHealthInput): JobHealthIssue[] {
  const now = input.now.getTime();
  const states = new Map(input.jobs.map((job) => [job.name, job]));
  const observations = new Map(input.observations.map((row) => [row.key, row.value]));
  const issues: JobHealthIssue[] = [];
  for (const entry of catalogJobsForBatch(input.batch)) {
    if (entry.intervalMs === null) continue;
    const state = states.get(entry.name);
    if (!state || !state.lastRunAt || state.lastError || isPausedJob(state, now)) continue;
    if (input.silentRoles?.has(entry.role)) continue;
    const limits = jobHealthThresholds(entry.intervalMs);
    const lastSuccess = state.lastSuccessAt?.getTime() ?? null;
    // 지금 이어지는 제 일 못 함 — 제대로 끝난 틱은 러너가 이 칸을 lastDegraded 로 옮기므로 있으면 마지막 틱이 못 한 것이다
    const degraded = readJobDegraded(observations.get(`job:${entry.name}`)).current;
    const deferral = input.deferrals?.get(entry.name) ?? null;
    const deferredSince = deferral && (lastSuccess === null || Date.parse(deferral.at) > lastSuccess) ? deferral : null;
    const degradedLevel = !degraded ? null : degraded.critical || degraded.streak >= limits.degradedCriticalRuns ? "critical"
      : degraded.streak >= limits.degradedHoldRuns ? "hold" : null;
    // 까닭 모를 성공 끊김 — 미룸을 읽지 못했거나 일부러 미룬 것이면 고장으로 부르지 않는다
    let staleLevel: JobHealthIssue["level"] | null = null;
    // 스케줄러가 끊기면 모든 잡의 성공이 함께 끊긴다 — 그것은 스케줄러 경보가 말한다
    if (input.deferrals !== null && !input.silentRoles?.has("scheduler") && !(deferredSince && DELIBERATE_DEFERRALS.has(deferredSince.reason))) {
      // 성공한 적이 없으면 틱 수로 잰다 — 주기 6번(짧은 잡은 30분어치) 넘게 돌고도 한 번도 성공하지 못했다
      const measure = lastSuccess === null ? state.runs * entry.intervalMs : now - lastSuccess;
      staleLevel = measure >= limits.staleCriticalMs ? "critical" : measure >= limits.staleHoldMs ? "hold" : null;
    }
    const level = degradedLevel === "critical" || staleLevel === "critical" ? "critical" : degradedLevel ?? staleLevel;
    if (!level) continue;
    issues.push({ job: entry.name, level, kind: degradedLevel ? "degraded" : "stale", degraded, deferral: deferredSince,
      lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null, sinceSuccessMs: lastSuccess === null ? null : Math.max(0, now - lastSuccess) });
  }
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1)
    || (b.sinceSuccessMs ?? Number.MAX_SAFE_INTEGER) - (a.sinceSuccessMs ?? Number.MAX_SAFE_INTEGER));
}

/** 성공 끊김 판정에 미룸 까닭이 필요한 잡 — 주기의 바닥(30분)보다 오래 성공하지 못한 것. 보통 비어 있어 읽기를 건너뛴다 */
export function jobsNeedingDeferralReason(jobs: readonly JobHealthState[], now: Date): string[] {
  return jobs.filter((job) => job.lastRunAt && !job.lastError
    && (job.lastSuccessAt === null || now.getTime() - job.lastSuccessAt.getTime() >= JOB_HEALTH_FLOOR_MS)).map((job) => job.name);
}

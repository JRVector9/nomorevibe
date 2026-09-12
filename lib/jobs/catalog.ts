/** Metadata only: importing this from the web must not load executable collectors. */
export type JobRole = "crawler" | "reviewer" | "publisher" | "maintenance";
export const JOB_ROLES: readonly JobRole[] = ["crawler", "reviewer", "publisher", "maintenance"];

export const JOB_CATALOG: readonly { name: string; role: JobRole | "scheduler"; intervalMs: number | null }[] = [
  { name: "heartbeat", role: "scheduler", intervalMs: null },
  /**
   * 검색 쿼터는 토큰 단위(30회/분 = 시간당 1,800페이지)라 워커를 늘려도 늘지 않는다.
   * 병목은 이 주기였다 — 15분 × 10페이지면 시간당 40페이지로 허용량의 2.2%만 썼다.
   * 3분으로 당겼더니 하루 5천 건이 들어와 1,287건이 자동 발행됐다 — 사람이 품질을 볼
   * 겨를이 없었다. 수집 속도는 발행 속도이기도 하다. 10분으로 되돌린다.
   */
  { name: "crawl-seed", role: "crawler", intervalMs: 10 * 60_000 },
  // 하루 약 123건이 올라온다. 30분이면 한 번에 100건 상한에 걸릴 일이 없다.
  { name: "hn-show-seed", role: "crawler", intervalMs: 30 * 60_000 },
  { name: "crawl-fetch", role: "crawler", intervalMs: 60_000 },
  { name: "crawl-judge", role: "reviewer", intervalMs: 5 * 60_000 },
  { name: "crawl-agent-review", role: "reviewer", intervalMs: 60_000 },
  // 2차 심사 — 1차와 다른 모델. 하루 수십~백여 건이라 5분이면 밀리지 않는다
  { name: "second-review", role: "reviewer", intervalMs: 60_000 },
  { name: "crawl-publish", role: "publisher", intervalMs: 5 * 60_000 },
  // 사유 번역 — 발행 워커가 대부분 비어 있어 여기서 1분마다 옮긴다(틱 55초, 한 번에 4건·1,600자까지)
  { name: "reason-translate", role: "publisher", intervalMs: 60_000 },
  /**
   * 1분마다 15건 = 시간당 900건. 발행분 3,147건을 재확인 간격 6시간마다 보려면 시간당 525건이
   * 필요한데, 10분 주기(시간당 90건)로는 6시간 안에 17%만 볼 수 있었다.
   *
   * crawler가 아니라 maintenance에서 돈다. 워커는 역할 안의 잡을 하나씩 차례로 돌린다
   * (scripts/worker.ts). crawler는 1분짜리 셋(예산 25·25·20초)만으로 시간당 4,200초라 이미
   * 한 프로세스의 3,600초를 넘는다 — 여기에 1분 주기(시간당 1,500초)를 얹으면 수집이 더 밀린다.
   * maintenance는 1시간에 한 번 도는 집계(click-rollup, 뒤따르는 ranking-refresh)뿐이라 한가하고,
   * 잡 한도도 600초로 느린 틱을 견딘다. 집계가 도는 동안은 기다린다 — 한 시간에 10틱을 잃어도
   * 시간당 750건이라 6시간 재확인은 지킨다.
   */
  { name: "uptime-ping", role: "maintenance", intervalMs: 60_000 },
  { name: "click-rollup", role: "maintenance", intervalMs: 60 * 60_000 },
  // The rollup completion transaction requests ranking; there is no independent schedule.
  { name: "ranking-refresh", role: "maintenance", intervalMs: null },
  /**
   * AI 소식(공식 피드 18곳)은 한 시간에 한 번이면 된다 — 회사 발표는 하루 몇 건이다.
   * crawler는 이미 시간을 넘겨 쓰고 있어 한가한 maintenance에 둔다(위 uptime-ping 설명).
   */
  { name: "news-refresh", role: "maintenance", intervalMs: 60 * 60_000 },
  { name: "product-evidence-refresh", role: "crawler", intervalMs: 60_000 },
  { name: "agent-evidence-refresh", role: "crawler", intervalMs: 60_000 },
  // 새 스타 값은 하루 한 번. 한 틱 40건·15초 이내로 기존 수집 예산을 보존한다.
  { name: "product-stars-refresh", role: "crawler", intervalMs: 5 * 60_000 },
];

export const JOB_NAMES = JOB_CATALOG.map(job => job.name);
export function isJobName(name: string): boolean { return JOB_NAMES.includes(name); }
export function jobsForRole(role: JobRole): string[] {
  return JOB_CATALOG.filter(job => job.role === role).map(job => job.name);
}

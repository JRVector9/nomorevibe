import type { LedgerBucket, WatchAuditRow, WatchContext } from "@/lib/operations/change-watch";
import ledger from "./change-watch-prod-ledger.json";
import probe from "./console-home-probe.json";

/**
 * 바꾼 것 지켜보기의 운영 실측 — 2026-11-12 배포(main 079550d5) 직후 14:57 KST(05:57Z) 읽기 전용 실측
 * (console-build/prod-samples/change-watch-20261112.json: 판정된 줄 31 · 할 일 12)을 시험용으로 줄인 것.
 *
 * - 작업 로그: 실측 줄(id·때·처리자·대상)을 그대로 옮겼다. 실측 파일에 없는 배포 창의 접수 중단·열림과 잡 멈춤 줄은
 *   재개 줄과 실측의 「접수 중단 14분이 겹칩니다」에 맞춰 넣었다(첫 재개 13분 30초 전에 중단·멈춤, 마지막 재개 10초 뒤 열림).
 *   23:08~23:26 의 접수 중단(JR)은 대표 사례 fixture(change-watch.ts)와 같다.
 * - 장부(change-watch-prod-ledger.json): 실측 31줄의 measure(바꾸기 전 시간별 수·첫 10분·첫 1시간·지금 1시간·바꾼 뒤 모두)를
 *   그대로 내는 5분 칸 수를 거꾸로 푼 것 — 27줄의 측정값을 모두 똑같이 다시 낸다(장부 원본은 아니다).
 * - 단계 대기: 같은 날 08:59 KST 워커 진행(console-home-probe — AI 1차 857 · 키워드 검수 36,882 · 키워드 짓기 0 등). 실측 때의 대기는 읽지 않았다.
 */
export const PROD_NOW = Date.parse(ledger.now);

export const PROD_CONN = {
  supa: "11111111-1111-4111-8111-111111111111", gpu: "22222222-2222-4222-8222-222222222222", opencode: "33333333-3333-4333-8333-333333333333",
  m1max: "e64b49ce-1e2b-492c-9f1f-3b71c138bc4d", exaone: "c8f1666d-e05c-4b84-9dba-eba484e8dfd3", deepseek: "44444444-4444-4444-8444-444444444444",
} as const;

const row = (id: number, at: string, action: string, target: string, detail: Record<string, unknown>, actor = "jr-claude", actorKind: string | null = null): WatchAuditRow =>
  ({ id, at, actor, actorKind, action, target, detail });

/** 배포 창 — 재개 줄(실측 id·잡·때)과 그 앞뒤 접수 줄 id */
const WINDOWS: readonly { drain: number; open: number; resumes: readonly (readonly [number, string, string])[] }[] = [
  { drain: 27930, open: 27965, resumes: [[27960, "reason-translate", "2026-11-11T06:34:25.341Z"], [27961, "product-search-profile", "2026-11-11T06:34:26.584Z"],
    [27962, "product-translate", "2026-11-11T06:34:27.832Z"], [27964, "crawl-publish", "2026-11-11T06:34:30.312Z"]] },
  { drain: 28020, open: 28036, resumes: [[28030, "reason-translate", "2026-11-11T08:36:06.794Z"], [28031, "product-search-profile", "2026-11-11T08:36:08.040Z"],
    [28032, "product-translate", "2026-11-11T08:36:09.275Z"], [28034, "crawl-publish", "2026-11-11T08:36:11.774Z"], [28035, "product-search-verify", "2026-11-11T08:36:13.048Z"]] },
  { drain: 28290, open: 28309, resumes: [[28303, "reason-translate", "2026-11-11T11:47:36.610Z"], [28304, "product-search-profile", "2026-11-11T11:47:37.856Z"],
    [28305, "product-translate", "2026-11-11T11:47:39.097Z"], [28307, "crawl-publish", "2026-11-11T11:47:41.568Z"], [28308, "product-search-verify", "2026-11-11T11:47:42.805Z"]] },
  { drain: 30380, open: 30403, resumes: [[30397, "reason-translate", "2026-11-12T02:55:08.453Z"], [30398, "product-search-profile", "2026-11-12T02:55:09.697Z"],
    [30399, "product-translate", "2026-11-12T02:55:10.939Z"], [30401, "crawl-publish", "2026-11-12T02:55:13.423Z"], [30402, "product-search-verify", "2026-11-12T02:55:14.667Z"]] },
  { drain: 30500, open: 30521, resumes: [[30515, "reason-translate", "2026-11-12T05:53:00.312Z"], [30516, "product-search-profile", "2026-11-12T05:53:01.579Z"],
    [30517, "product-translate", "2026-11-12T05:53:02.832Z"], [30519, "crawl-publish", "2026-11-12T05:53:05.347Z"], [30520, "product-search-verify", "2026-11-12T05:53:06.610Z"]] },
];

const shift = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

/** 배포 창 줄 — pauseActor 를 바꾸면 자동 처리자가 멈춘 경우(재개 줄만 사람)를 본다 */
export function prodWindowRows(pauseActor: { actor: string; actorKind: string | null } = { actor: "jr-claude", actorKind: null }): WatchAuditRow[] {
  return WINDOWS.flatMap(window => {
    const start = shift(window.resumes[0][2], -13.5 * 60);
    const last = window.resumes.at(-1)![2];
    return [
      row(window.drain, start, "pipeline-control-capacity-mode", "model_capacity_control", { mode: "draining", beforeMode: "open" }),
      ...window.resumes.map(([, job], index) => row(window.drain + 1 + index, shift(start, 5 + index * 1.2), "job-pause", job, { reason: "배포 창 · 앱 교체" },
        pauseActor.actor, pauseActor.actorKind)),
      ...window.resumes.map(([id, job, at]) => row(id, at, "job-resume", job, { reason: "배포 창 · 앱 교체", previousControlVersion: window.drain + 1 + window.resumes.findIndex(entry => entry[0] === id) })),
      row(window.open, shift(last, 10), "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open", beforeMode: "draining" }),
    ];
  });
}

/** 배포 창 밖의 실측 변경 — 순위 저장 둘, 한도 저장, 모델 저장 넷, 23:08 접수 중단(JR) */
export const PROD_CHANGES: readonly WatchAuditRow[] = [
  row(27972, "2026-11-11T06:37:20.452Z", "runtime-settings-save", "runtime_settings:jobs", { changes: [
    { path: "jobs.product-search-verify.minRemainingMs", label: "키워드 검수 최소 남은 시간(ms)" }, { path: "jobs.product-search-verify.batchMax", label: "키워드 검수 한 번에" }] }),
  row(28010, "2026-11-11T07:54:57.821Z", "ai-task-models-save", "product-audit#1", {
    before: [{ rank: 1, connectionId: PROD_CONN.deepseek, model: "deepseek" }, { rank: 2, connectionId: PROD_CONN.gpu, model: "qwen" }, { rank: 3, connectionId: PROD_CONN.supa, model: "supa" }],
    after: [{ rank: 1, connectionId: PROD_CONN.deepseek, model: "deepseek" }, { rank: 2, connectionId: PROD_CONN.opencode, model: "opencode" }, { rank: 3, connectionId: PROD_CONN.gpu, model: "qwen" }] }),
  row(28353, "2026-11-11T12:13:34.003Z", "ai-connection-save", "M1max", { id: PROD_CONN.m1max, created: true, keyChanged: false, label: "M1max" },
    "codex:user-request:m1max-register"),
  row(28371, "2026-11-11T12:24:44.227Z", "ai-connection-save", "M1max", { id: PROD_CONN.m1max, created: false, keyChanged: true, label: "M1max" }, "codex:user-request:m1max-key-slots2"),
  row(28845, "2026-11-11T22:06:12.829Z", "ai-connection-save", "M1max", { id: PROD_CONN.m1max, created: false, keyChanged: false, label: "M1max" }, "jr", "github"),
  row(28847, "2026-11-11T22:06:46.943Z", "ai-connection-save", "LG EXAONE", { id: PROD_CONN.exaone, created: false, keyChanged: false, label: "LG EXAONE" }, "jr", "github"),
  row(28853, "2026-11-11T22:10:26.608Z", "ai-task-models-save", "first-review#1", {
    before: [{ rank: 1, connectionId: PROD_CONN.opencode, model: "deepseek-v4" }, { rank: 2, connectionId: PROD_CONN.gpu, model: "qwen3.8" }],
    after: [{ rank: 1, connectionId: PROD_CONN.supa, model: "Inferact/Qwen3.8-27B-NVFP4" }, { rank: 2, connectionId: PROD_CONN.gpu, model: "qwen3.8" }] }, "jr", "github"),
  row(28863, "2026-11-11T23:08:04Z", "pipeline-control-capacity-mode", "model_capacity_control", { mode: "draining", beforeMode: "open" }, "JR"),
  row(28864, "2026-11-11T23:26:26Z", "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open", beforeMode: "draining" }, "JR"),
];

export const prodAudit = (pauseActor?: { actor: string; actorKind: string | null }): WatchAuditRow[] =>
  [...prodWindowRows(pauseActor), ...PROD_CHANGES].sort((a, b) => a.id - b.id);

export const PROD_CONTEXT: WatchContext = {
  connectionTasks: new Map([[PROD_CONN.exaone, ["product-tagline-ko"]], [PROD_CONN.supa, ["first-review", "product-search-verify", "second-review"]]]),
  connectionLabels: new Map([[PROD_CONN.supa, "supa-direct"], [PROD_CONN.gpu, "gpu3090-qwen"], [PROD_CONN.opencode, "M3 OpenCode"], [PROD_CONN.m1max, "M1max"],
    [PROD_CONN.exaone, "LG EXAONE"], [PROD_CONN.deepseek, "m3-deepseek"]]),
};

/** 장부 — route 마다 첫 칸 번호와 5분 칸 수(0 은 뺀다). 발행분 감사는 두 경로(local-audit · product-audit)의 합을 product-audit 하나에 실었다 */
export const PROD_LEDGER: LedgerBucket[] = Object.entries(ledger.routes as Record<string, { start: number; counts: number[] }>)
  .flatMap(([route, series]) => series.counts.flatMap((settled, index) => settled ? [{ route, bucket: series.start + index, settled }] : []));

export const PROD_PROGRESS: readonly { job?: string | null; waiting?: number | null }[] = probe.progress.stages;

/**
 * 고치기 전(main 079550d5) 실측이 홈 「평소와 다름」에 올린 바꾼 것 지켜보기 할 일 12건 — 열쇠 · 판정 · 제목(실측 파일 tasks 그대로).
 * 같은 때 홈에는 이 가운데 10건과 보류 급증 1건이 올라 있었다(평소와 다름 11).
 */
export const PROD_TASKS_BEFORE: readonly { key: string; verdict: string; title: string }[] = [
  { key: "change-watch:30402", verdict: "worse", title: "검색 키워드 검수 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:30399", verdict: "worse", title: "제품 다국어 번역 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:30397", verdict: "worse", title: "심사 사유 번역 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:28308", verdict: "fell_back", title: "검색 키워드 검수 처리가 바꾼 뒤 다시 줄었습니다" },
  { key: "change-watch:28304", verdict: "worse", title: "검색 키워드 짓기 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:28035", verdict: "worse", title: "검색 키워드 검수 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:28032", verdict: "fell_back", title: "제품 다국어 번역 처리가 바꾼 뒤 다시 줄었습니다" },
  { key: "change-watch:28031", verdict: "worse", title: "검색 키워드 짓기 처리가 바꾼 뒤 줄었습니다" },
  { key: "change-watch:28010", verdict: "fell_back", title: "발행분 감사 · 변경 재판정 처리가 바꾼 뒤 다시 줄었습니다" },
  { key: "change-watch:27972", verdict: "fell_back", title: "검색 키워드 검수 처리가 바꾼 뒤 다시 줄었습니다" },
  { key: "change-watch:27961", verdict: "fell_back", title: "검색 키워드 짓기 처리가 바꾼 뒤 다시 줄었습니다" },
  { key: "change-watch:27960", verdict: "fell_back", title: "심사 사유 번역 처리가 바꾼 뒤 다시 줄었습니다" },
];

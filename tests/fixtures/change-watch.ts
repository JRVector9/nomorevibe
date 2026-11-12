import type { LedgerBucket, WatchAuditRow, WatchContext } from "@/lib/operations/change-watch";

/**
 * 바꾼 것 지켜보기의 대표 사례 — 2026-11-12 실측(최종 시안 「바꾼 것 지켜보기」 첫 줄).
 * 11-12 07:10 KST(22:10:26Z) 1차 AI 검수 1순위를 supa 로 바꿈 → 바꾸기 전 6시간 시간당 33·40·16·3·11·0건(평균 17), 바꾼 뒤 첫 1시간 86건,
 * 그 뒤 최근 1시간 3건 → 「다시 떨어짐」. 같은 무렵의 모델 M1max 추가(쓰는 단계 없음, 세 번 저장)·LG EXAONE 저장(사유 번역)·접수 중단 18분을 함께 둔다.
 */
export const WATCH_NOW = Date.parse("2026-11-12T00:20:00Z"); // 09:20 KST

export const CONN = {
  supa: "11111111-1111-4111-8111-111111111111",
  gpu: "22222222-2222-4222-8222-222222222222",
  opencode: "33333333-3333-4333-8333-333333333333",
  m1max: "e64b49ce-1e2b-492c-9f1f-3b71c138bc4d",
  exaone: "c8f1666d-e05c-4b84-9dba-eba484e8dfd3",
} as const;

const row = (id: number, at: string, action: string, target: string, detail: Record<string, unknown>, actor = "jr", actorKind: string | null = "github"): WatchAuditRow =>
  ({ id, at, actor, actorKind, action, target, detail });

export const WATCH_AUDIT: WatchAuditRow[] = [
  row(28842, "2026-11-11T22:03:52Z", "job-pause", "audit-qwen", { reason: "모델 쉬게" }, "system:capacity", "system"),
  row(28845, "2026-11-11T22:06:12Z", "ai-connection-save", "M1max", { id: CONN.m1max, created: true, keyChanged: true, label: "M1max" }),
  row(28846, "2026-11-11T22:06:17Z", "ai-connection-save", "M1max", { id: CONN.m1max, created: false, keyChanged: false, label: "M1max" }),
  row(28847, "2026-11-11T22:06:46Z", "ai-connection-save", "LG EXAONE", { id: CONN.exaone, created: false, keyChanged: false, label: "LG EXAONE" }),
  row(28848, "2026-11-11T22:07:21Z", "ai-connection-save", "M1max", { id: CONN.m1max, created: false, keyChanged: false, label: "M1max" }),
  row(28853, "2026-11-11T22:10:26Z", "ai-task-models-save", "first-review#1", {
    task: "first-review", slot: 1,
    before: [{ rank: 1, slot: 1, task: "first-review", connectionId: CONN.opencode, model: "deepseek-v4" }, { rank: 2, slot: 1, task: "first-review", connectionId: CONN.gpu, model: "qwen3.8" }],
    after: [{ rank: 1, slot: 1, task: "first-review", connectionId: CONN.supa, model: "Inferact/Qwen3.8-27B-NVFP4" }, { rank: 2, slot: 1, task: "first-review", connectionId: CONN.gpu, model: "qwen3.8" }],
  }),
  row(28863, "2026-11-11T23:08:04Z", "pipeline-control-capacity-mode", "model_capacity_control", { mode: "draining" }, "JR", null),
  row(28864, "2026-11-11T23:26:26Z", "pipeline-control-capacity-mode", "model_capacity_control", { mode: "open" }, "JR", null),
];

export const WATCH_CONTEXT: WatchContext = {
  connectionTasks: new Map([[CONN.exaone, ["reason-translate"]], [CONN.supa, ["first-review", "product-search-verify"]], [CONN.gpu, ["first-review"]]]),
  connectionLabels: new Map([[CONN.supa, "supa"], [CONN.gpu, "gpu3090-qwen"], [CONN.opencode, "OpenCode deepseek"], [CONN.m1max, "M1max"], [CONN.exaone, "LG EXAONE"]]),
};

const B = 5 * 60_000;
const bucket = (iso: string) => Math.floor(Date.parse(iso) / B);

/** 1차 AI 검수(crawl-agent-review): 바꾸기 전 시간마다 한 칸에 몰아 둔다(합만 본다) · 사유 번역(reason-translate): 시간당 100건 안팎 */
export const WATCH_LEDGER: LedgerBucket[] = [
  ...[["2026-11-11T16:30:00Z", 33], ["2026-11-11T17:30:00Z", 40], ["2026-11-11T18:30:00Z", 16], ["2026-11-11T19:30:00Z", 3], ["2026-11-11T20:30:00Z", 11]]
    .map(([at, settled]) => ({ route: "crawl-agent-review", bucket: bucket(at as string), settled: settled as number })),
  { route: "crawl-agent-review", bucket: bucket("2026-11-11T22:10:00Z"), settled: 50 },
  { route: "crawl-agent-review", bucket: bucket("2026-11-11T22:40:00Z"), settled: 36 },
  { route: "crawl-agent-review", bucket: bucket("2026-11-11T23:45:00Z"), settled: 3 },
  // 다른 단계의 수는 섞이지 않는다
  { route: "second-review", bucket: bucket("2026-11-11T23:45:00Z"), settled: 400 },
  ...Array.from({ length: 30 }, (_, hour) => ({ route: "reason-translate", bucket: bucket(new Date(Date.parse("2026-11-11T16:00:00Z") + hour * 3_600_000).toISOString()),
    settled: hour === 7 ? 105 : 100 })).filter(entry => entry.bucket * B < WATCH_NOW),
];

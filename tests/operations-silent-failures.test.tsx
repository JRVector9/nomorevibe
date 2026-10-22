import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_KEYS, BADGED_HOLD_KEYS } from "@/lib/operations/attention";
import { buildActions, countBadgeActions, deriveStatus, splitActions, type ActionInputs, type DerivedStatus } from "@/app/(operator)/admin/status/attention";
import { ACTION_LINKS, jobHref } from "@/app/(operator)/admin/status/action-links";
import type { ActionItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { JobsStrip } from "@/app/(operator)/admin/status/dashboard/JobsStrip";
import type { OperationJob } from "@/app/(operator)/admin/status/OperationsCenter";
import { humanOverview } from "./fixtures/human-queue";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("server-only", () => ({}));

/**
 * 무음 실패(2026-10-22 점검) — 돌았지만 제 일을 못 한 작업과, 운영센터가 계산하고 버리던 상태를 조치할 일에 세운다.
 * 키·급·숫자·단위·가는 곳과 문턱을 고정한다. 문턱의 까닭은 lib/operations/job-health.ts·attention.tsx 주석에 있다.
 */
const NOW = new Date("2026-10-22T06:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();
afterEach(() => vi.unstubAllEnvs());

const job = (name: string, patch: Record<string, unknown> = {}) =>
  ({ name, lastRunAt: ago(MIN), lastSuccessAt: ago(MIN), lastError: null, nextScheduledAt: null, notBefore: null, runs: 100, ...patch });
const degraded = (name: string, streak: number, code = "search_failed", detail: string | null = "검색 http_503") =>
  ({ key: `job:${name}`, observedAt: iso(MIN), value: { done: true, events: [], degraded: { code, detail, critical: false, at: iso(MIN), streak, since: iso(streak * MIN) } } });

/** 다른 갈래는 모두 조용한 입력 — 읽지 못한 집계(roles 등)의 "미확인" 줄은 아래에서 키로 거른다 */
function inputs(patch: Partial<ActionInputs> & { observations?: unknown[] } = {}): ActionInputs {
  const { observations = [], ...rest } = patch;
  return {
    settings: {}, settingsApply: null,
    ops: { fetchedAt: NOW.toISOString(), observations, serviceInstances: [], dbLatencyMs: 1, audit: [], held: 0, heldNextRetryAt: null },
    jobStates: [], jobBatch: null, evidenceSummary: { due: 0, stale: 0, failed: 0, oldestDueHours: null }, downCount: 0, overview: humanOverview(),
    secondFailures: [], throughput: null, models: [], attention: null, roles: null, accounts: [], apps: [], takedowns: null, modelServers: [],
    jobDeferrals: new Map(), email: null,
    ...rest,
  } as unknown as ActionInputs;
}
const build = (value: ActionInputs, workerProgress: DerivedStatus["workerProgress"] = null) =>
  buildActions(value, { ...deriveStatus({ ...value, throughput: null }), workerProgress });
const find = (value: ActionInputs, key: string, workerProgress: DerivedStatus["workerProgress"] = null) => build(value, workerProgress).find((item) => item.key === key);
const text = (item: ActionItem | undefined) => renderToStaticMarkup(createElement(Fragment, null, item?.detail)).replace(/<[^>]*>/g, "")
  .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const NEW_KEYS = ["job-health", "uptime-held", "stage-upstream", "qwen-backoff", "email-outbox", "login-email", "ranking-stale"];

describe("돌기는 하는데 제 일을 못 하는 작업(job-health)", () => {
  it("검색이 막힌 HN 화제(보류)와 서버가 없는 의미 검색 벡터(긴급)를 한 줄에 — 작업 이름은 사람이 읽는 말, 까닭 코드는 그대로", () => {
    const value = inputs({
      jobStates: [job("hn-talk", { lastSuccessAt: ago(5 * 60 * MIN) }), job("product-embedding", { lastSuccessAt: ago(3 * 60 * MIN) })] as never,
      observations: [degraded("hn-talk", 3), degraded("product-embedding", 150, "embedding_unavailable", "임베딩 서버 network")],
    });
    const item = find(value, "job-health")!;
    expect(item).toMatchObject({ tone: "critical", count: 2, unit: "개", title: "작업이 오래 제 일을 하지 못합니다", action: { label: "작업 흐름", href: ACTION_LINKS.jobs } });
    expect(text(item)).toContain("의미 검색 벡터 제 일 못 함 embedding_unavailable(임베딩 서버 network) 연속 150회");
    expect(text(item)).toContain("HN 화제 수집 제 일 못 함 search_failed(검색 http_503) 연속 3회");
    expect(text(item)).not.toMatch(/hn-talk|product-embedding/);
    const single = find(inputs({ jobStates: [job("hn-talk", { lastSuccessAt: ago(5 * 60 * MIN) })] as never, observations: [degraded("hn-talk", 2)] }), "job-health")!;
    expect(single).toMatchObject({ tone: "hold", count: 1, title: "돌기는 하는데 제 일을 하지 못하는 작업", action: { href: jobHref("hn-talk") } });
  });

  it("한 번 못 한 것·던진 실패가 있는 것은 세우지 않는다(던진 실패는 '마지막 회차가 실패한 작업'이 맡는다)", () => {
    expect(find(inputs({ jobStates: [job("hn-talk")] as never, observations: [degraded("hn-talk", 1)] }), "job-health")).toBeUndefined();
    const thrown = inputs({ jobStates: [job("hn-talk", { lastError: "boom", lastSuccessAt: ago(9 * 60 * MIN) })] as never, observations: [degraded("hn-talk", 5)] });
    expect(build(thrown).map((item) => item.key)).toEqual(expect.arrayContaining(["jobs"]));
    expect(find(thrown, "job-health")).toBeUndefined();
  });

  it("까닭 모를 성공 끊김 — 마지막 미룸 까닭을 함께 적고, 미룸을 읽지 못한 입력(옛 입력)은 세우지 않는다", () => {
    const value = inputs({ jobStates: [job("crawl-agent-review", { lastSuccessAt: ago(45 * MIN) })] as never,
      jobDeferrals: new Map([["crawl-agent-review", { reason: "model_capacity", at: iso(MIN) }]]) });
    expect(find(value, "job-health")).toMatchObject({ tone: "hold", count: 1 });
    expect(text(find(value, "job-health"))).toContain("AI 후보 심사 성공 없음 · 마지막 성공 14:15 (45분 전) · 마지막 미룸 model_capacity");
    expect(find({ ...value, jobDeferrals: undefined }, "job-health")).toBeUndefined();
  });
});

describe("생존 확인 광역 실패 보류(uptime-held)", () => {
  it("보류가 잇달아 30번(30분어치)이면 보류, 120번이면 긴급 — 작업 묶음 줄에는 겹쳐 세우지 않는다", () => {
    const held = (streak: number) => inputs({ jobStates: [job("uptime-ping", { lastSuccessAt: ago(streak * MIN) })] as never,
      observations: [degraded("uptime-ping", streak, "broad_failure_held", "확인 50 · 실패 40 · 모름 0")] });
    expect(find(held(29), "uptime-held")).toBeUndefined();
    const item = find(held(30), "uptime-held")!;
    expect(item).toMatchObject({ tone: "hold", count: 30, unit: "회", title: "생존 확인이 광역 실패로 판정을 보류하고 있습니다", action: { href: jobHref("uptime-ping") } });
    expect(text(item)).toContain("서비스 응답 점검 회차가 잇달아 30번 30% 넘게 실패해");
    expect(text(item)).toContain("마지막 확인 50 · 실패 40 · 모름 0");
    expect(text(item)).toContain("응답 없음·생존 확인 밀림 수는 0 으로 보입니다");
    expect(find(held(30), "job-health")).toBeUndefined();
    expect(find(held(120), "uptime-held")).toMatchObject({ tone: "critical" });
  });
});

describe("바깥 오류로 멈춘 단계(stage-upstream) — 진행 판정이 경보로 세고 버리던 것", () => {
  const progress = (minutes: number) => ({ liveness: [], scheduler: { role: "scheduler", reason: "scheduled", alarm: false, overdueJobs: [] },
    stages: [{ role: "crawler", stage: "fetch", reason: "upstream_stalled", alarm: true, job: "crawl-fetch", waiting: 40, oldestMinutes: minutes, errors5m: 3 }],
  }) as unknown as DerivedStatus["workerProgress"];
  const value = inputs({ throughput: { measuredAt: NOW.toISOString(), stages: [{ key: "fetch", label: "원본 수집" }] } as never });

  it("30분이면 보류, 2시간이면 긴급 — 단계 이름·대기·오류를 적고 그 작업 상세로 보낸다", () => {
    const item = find(value, "stage-upstream", progress(45))!;
    expect(item).toMatchObject({ tone: "hold", count: 1, unit: "단계", title: "바깥 오류로 단계가 나아가지 않습니다", action: { href: jobHref("crawl-fetch") } });
    expect(text(item)).toContain("원본 수집 대기 40건 · 45분째 · 최근 5분 오류 3");
    expect(text(item)).toContain("워커를 다시 띄워도 풀리지 않습니다");
    expect(find(value, "stage-upstream", progress(120))).toMatchObject({ tone: "critical" });
  });
});

describe("Qwen 직접 서버 물러나기(qwen-backoff) — 감사 화면에만 보이던 것", () => {
  const qwen = (failures: number, patch: Record<string, unknown> = {}) => inputs({ observations: [{ key: "qwen-endpoint", observedAt: iso(MIN),
    value: { failures, retryAt: new Date(NOW.getTime() + 15 * MIN).toISOString(), lastError: "qwen_unreachable", at: iso(MIN), ...patch } }] });

  it("6번째 탈(누적 30분)이면 보류, 12번째(누적 2시간)면 긴급 — 서버 이름은 설정에서 읽는다", () => {
    expect(find(qwen(5), "qwen-backoff")).toBeUndefined();
    const item = find(qwen(6), "qwen-backoff")!;
    // AUDIT_SECOND_OPINION_LABEL 이 없으면 부르는 주소의 호스트
    expect(item).toMatchObject({ tone: "hold", count: 6, unit: "회", title: "Qwen 직접 서버(100.77.43.63:8090)가 잇달아 실패해 물러나 있습니다",
      action: { href: ACTION_LINKS.audit } });
    expect(text(item)).toContain("연속 6번 · 마지막 qwen_unreachable · 다음 시도");
    vi.stubEnv("AUDIT_SECOND_OPINION_LABEL", "gpu3090");
    expect(find(qwen(12), "qwen-backoff")).toMatchObject({ tone: "critical", title: "Qwen 직접 서버(gpu3090)가 잇달아 실패해 물러나 있습니다" });
  });

  it("부르는 쪽이 없어 묵은 관측(물러나기도 끝났고 30분 넘게 그대로)은 세우지 않는다", () => {
    expect(find(qwen(9, { retryAt: iso(60 * MIN), at: iso(90 * MIN) }), "qwen-backoff")).toBeUndefined();
    expect(find(qwen(9, { retryAt: iso(MIN), at: iso(10 * MIN) }), "qwen-backoff")).toMatchObject({ tone: "hold" });
  });
});

describe("알림 메일·로그인 코드 메일 — 어떤 관리자 화면도 읽지 않던 것", () => {
  const outbox = { pending: 4, pendingOverdue: 2, oldestPendingMinutes: 130, accepted: 10, unknown: 1, rejected: 2, expired: 0 };
  const login = { total24h: 0, failed24h: 0, recent: [] as string[] };
  const email = (o: Partial<typeof outbox> = {}, l: Partial<typeof login> = {}) => inputs({ email: { outbox: { ...outbox, ...o }, login: { ...login, ...l } } as never });

  it("못 보내고 닫은 줄·1시간 넘은 대기가 있으면 보류, 가장 오래 기다린 것이 4시간을 넘거나 하나도 못 보냈으면 긴급", () => {
    const item = find(email(), "email-outbox")!;
    expect(item).toMatchObject({ tone: "hold", count: 3, unit: "통", title: "알림 메일이 나가지 않습니다", action: { href: jobHref("email-outbox-send") } });
    expect(text(item)).toContain("최근 이틀 결과 모름 1 · 못 보내고 하루 지나 닫음 0 · 거절 2 · 보냄 10 · 대기 4(1시간 넘음 2, 가장 오래 2시간)");
    expect(find(email({ oldestPendingMinutes: 240 }), "email-outbox")).toMatchObject({ tone: "critical" });
    expect(find(email({ unknown: 2, expired: 1, accepted: 0, pendingOverdue: 0 }), "email-outbox")).toMatchObject({ tone: "critical", count: 3 });
    // Resend 거절은 그 메일 탓일 수 있어 세기만 한다
    expect(find(email({ unknown: 0, pendingOverdue: 0, rejected: 5 }), "email-outbox")).toBeUndefined();
  });

  it("보내는 잡의 제 일 못 함(발신 설정 없음)도 같은 줄에 — 작업 묶음 줄에는 겹쳐 세우지 않는다", () => {
    const value = inputs({ jobStates: [job("email-outbox-send", { lastSuccessAt: ago(40 * MIN) })] as never,
      observations: [degraded("email-outbox-send", 30, "sender_unconfigured", "maintenance 에 발신 설정이 없어 4통이 기다립니다")] });
    const item = find(value, "email-outbox")!;
    expect(item).toMatchObject({ tone: "hold", count: 0 });
    expect(text(item)).toContain("발송함 결과를 읽지 못했습니다 · 알림 메일 보내기 제 일 못 함 sender_unconfigured(maintenance 에 발신 설정이 없어 4통이 기다립니다) 연속 30회");
    expect(find(value, "job-health")).toBeUndefined();
  });

  it("로그인 코드 메일 — 한 통이라도 실패하면 보류, 가장 최근 세 통이 모두 실패면 긴급", () => {
    expect(find(email({ unknown: 0, pendingOverdue: 0 }), "login-email")).toBeUndefined();
    const item = find(email({ unknown: 0, pendingOverdue: 0 }, { total24h: 5, failed24h: 1, recent: ["accepted", "rejected", "accepted"] }), "login-email")!;
    expect(item).toMatchObject({ tone: "hold", count: 1, unit: "통", title: "로그인 코드 메일 일부가 실패했습니다", action: { href: ACTION_LINKS.roles } });
    expect(text(item)).toContain("최근 24시간 5통 중 거절·결과 모름 1통");
    expect(find(email({}, { total24h: 3, failed24h: 3, recent: ["rejected", "unknown", "rejected"] }), "login-email"))
      .toMatchObject({ tone: "critical", title: "로그인 코드 메일이 나가지 않습니다" });
  });
});

describe("랭킹 멈춤(ranking-stale) — 주기가 없어 작업 띠에서 늘 초록이던 것", () => {
  const ranking = (patch: Record<string, unknown>) => inputs({ jobStates: [job("ranking-refresh", patch), job("click-rollup", { lastSuccessAt: ago(20 * MIN) })] as never });
  it("공개 화면이 '오래됨'을 붙이는 2시간이면 보류, 그 4배(8시간)면 긴급 — 집계 작업의 마지막 성공을 함께 적는다", () => {
    expect(find(ranking({ lastSuccessAt: ago(119 * MIN) }), "ranking-stale")).toBeUndefined();
    const item = find(ranking({ lastSuccessAt: ago(3 * 60 * MIN), lastRunAt: ago(3 * 60 * MIN) }), "ranking-stale")!;
    expect(item).toMatchObject({ tone: "hold", count: 3, unit: "시간", title: "랭킹이 2시간 넘게 갱신되지 않았습니다", action: { href: jobHref("ranking-refresh") } });
    expect(text(item)).toContain("랭킹 갱신 마지막 성공 12:00 (3시간 전) · 유효 방문 집계 마지막 성공 14:40 (20분 전)");
    expect(find(ranking({ lastSuccessAt: ago(9 * 60 * MIN) }), "ranking-stale")).toMatchObject({ tone: "critical", count: 9 });
    expect(find(ranking({ lastSuccessAt: null }), "ranking-stale")).toMatchObject({ tone: "critical", count: "없음", unit: "상태" });
    // 한 번도 돌지 않은 새 환경은 세우지 않는다
    expect(find(ranking({ lastSuccessAt: null, lastRunAt: null }), "ranking-stale")).toBeUndefined();
  });
});

describe("메뉴 배지와 나누기", () => {
  it("새 경보는 쌓인 일이 아니다 — 확인함으로 숨길 수 없고 지금 조치에 선다", () => {
    for (const key of NEW_KEYS) expect(BACKLOG_KEYS.has(key), key).toBe(false);
    const items: ActionItem[] = NEW_KEYS.map((key) => ({ key, tone: "hold", count: 1, unit: "개", title: key, detail: key }));
    expect(splitActions(items, { samples: [], acks: new Map(), now: NOW }).urgent.map((item) => item.key)).toEqual(NEW_KEYS);
  });

  it("긴급은 그대로 세고, 보류는 무음 실패 열쇠만 센다 — 쌓인 일·원래 있던 보류는 세지 않는다", () => {
    expect([...BADGED_HOLD_KEYS].sort()).toEqual([...NEW_KEYS, "x-delivery"].sort());
    const item = (key: string, tone: ActionItem["tone"]): ActionItem => ({ key, tone, count: 1, unit: "개", title: key, detail: key });
    expect(countBadgeActions([item("job-health", "hold"), item("x-delivery", "hold"), item("review", "hold"), item("model-servers", "hold"),
      item("down", "critical"), item("ranking-stale", "critical")])).toEqual({ critical: 2, hold: 2 });
  });
});

describe("작업 띠 — 돈 시각이 아니라 진짜 성공·제 일 못 함으로 색을 고른다", () => {
  const operationJob = (name: string, patch: Partial<OperationJob> = {}): OperationJob => ({ name, status: "유휴", lastRunAt: iso(MIN), lastSuccessAt: iso(MIN),
    nextScheduledAt: null, notBefore: null, workerSeenAt: null, requestedVersion: 1, processedVersion: 1, runs: 1, lastError: null, cursor: "null", ...patch });
  it("방금 돌았어도 제 일 못 함이 보류면 주황, 긴급이면 빨강 — 칩에는 마지막 성공을 적는다", () => {
    const html = renderToStaticMarkup(createElement(JobsStrip, { now: NOW.toISOString(), onOpen: () => {}, jobs: [
      operationJob("hn-talk", { lastSuccessAt: iso(5 * 60 * MIN), health: { level: "hold", text: "제 일 못 함 search_failed · 연속 3회" } }),
      operationJob("product-embedding", { lastSuccessAt: iso(3 * 60 * MIN), health: { level: "critical", text: "제 일 못 함 embedding_unavailable · 연속 150회" } }),
      operationJob("crawl-fetch"),
    ] }));
    const chip = (name: string) => html.split("<button").find((part) => part.includes(`title="${name}`))!;
    expect(chip("hn-talk")).toContain('data-tone="warn"');
    expect(chip("hn-talk")).toContain("성공 5시간 전");
    expect(chip("hn-talk")).toContain("제 일 못 함 search_failed");
    expect(chip("product-embedding")).toContain('data-tone="bad"');
    expect(chip("crawl-fetch")).toContain('data-tone="ok"');
  });
});

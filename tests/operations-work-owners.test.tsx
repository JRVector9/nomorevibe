import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { buildActions, deriveStatus, type ActionInputs, type DerivedStatus } from "@/app/(operator)/admin/status/attention";
import { AttentionList, type SplitItem } from "@/app/(operator)/admin/status/dashboard/AttentionList";
import { JOB_HOW, hostName, resolveWorkOwners, workOwnersByAction, type OwnerContext } from "@/app/(operator)/admin/status/work-owners";
import { ACTION_NOW, brokenActionInputs, brokenWorkerProgress } from "./fixtures/operations-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("server-only", () => ({}));

/**
 * 조치 칸의 장비·LLM 버튼(work-owners.ts) — 칸마다 그 일을 맡은 작업을 달고, 작업에서 장비(역할 담당·consumer·모델 서버)·LLM·일정을 모은다.
 * 입력 모양은 2026-10-23 운영에서 읽은 것(다섯 역할 모두 M3 주, 제작 근거 consumer M3·Oracle, 2차 [supa] Qwen3.8 한 표, AI 연결 Codex→Sonnet)이다.
 */
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ACTION_NOW);
});
afterAll(() => vi.useRealTimers());

const NOW = ACTION_NOW.toISOString();
const ago = (seconds: number) => new Date(ACTION_NOW.getTime() - seconds * 1_000).toISOString();
const instance = (role: string, instanceId: string, value: Record<string, unknown>, seconds = 5) =>
  ({ role, instanceId, observedAt: ago(seconds), value: { release: "5ba60a1aef1878add561152ef8273b2df87e03d4", ...value } });
const lease = (role: string, ownerInstanceId: string, ownerKind = "primary") =>
  ({ role, ownerInstanceId, ownerKind, ownerRelease: "5ba60a1aef1878add561152ef8273b2df87e03d4", secondsUntilExpiry: 40 });

const ENV = { AUDIT_SECOND_OPINION_LABEL: "gpu3090" };
function context(over: Partial<OwnerContext> = {}): OwnerContext {
  return {
    settings: {
      firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
      secondReview: { voters: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }], fallbacks: [] },
      humanReview: { enabled: false, generation: 0 },
      qwenAuto: { splitTiebreak: { enabled: true }, heldRetry: { enabled: true }, auditSecondOpinion: { enabled: false },
        publishedFilter: { enabled: false }, screenReview: { enabled: false } },
    } as unknown as OwnerContext["settings"],
    roles: [lease("crawler", "m3-crawler"), lease("reviewer", "m3-reviewer"), lease("publisher", "m3-publisher"),
      lease("text", "m3-text"), lease("maintenance", "m3-maintenance")],
    instances: [
      instance("crawler", "m3-crawler", { lanes: [{ jobs: ["crawl-seed"], currentJob: null }, { jobs: ["agent-evidence-refresh"], currentJob: "agent-evidence-refresh" }] }),
      instance("crawler", "agent-scan-consumer-m3", { state: "running" }),
      instance("crawler", "agent-scan-consumer-oracle", { state: "idle", release: "6e452f8360d6dcb7e9a7ac737d169d3abbfcf9fa" }),
      // 한 시간 넘게 관측이 없는 consumer 는 장비로 세지 않는다
      instance("maintenance", "uptime-consumer-oracle", { state: "idle" }, 7_200),
      instance("connect-agent", "m3-connect-agent", {}),
    ],
    jobs: new Map([["agent-evidence-refresh", { lastRunAt: new Date(ago(30)), lastSuccessAt: new Date(ago(30)), nextScheduledAt: new Date(ago(-30)), notBefore: null, lastError: null }]]),
    batch: { mode: "legacy", writerContractVersion: 0 },
    agent: { config: { primary: { model: "gpt-5.6-terra", effort: "xhigh" }, fallback: { model: "sonnet", effort: "high" } }, configVersion: 4 } as OwnerContext["agent"],
    models: [{ key: "second", label: "2차 투표", calls1h: 34, failed1h: 8 }],
    now: NOW, env: ENV,
    ...over,
  };
}

describe("작업마다 하는 일", () => {
  it("카탈로그의 모든 작업에 한 틱이 하는 일을 적는다 — 새 작업을 더하면 여기도 적어야 한다", () => {
    expect(JOB_CATALOG.map((job) => job.name).filter((name) => !JOB_HOW[name])).toEqual([]);
  });

  it("인스턴스 이름에서 장비를 읽는다", () => {
    expect(["m3-crawler", "mini-crawler-standby", "agent-scan-consumer-oracle", "agent-scan-consumer-m3", "m3-scheduler-7d233478d0ce", "osaka-smoke", "gpu3090"]
      .map(hostName)).toEqual(["M3", "mini", "Oracle", "M3", "M3", "Oracle", "gpu3090"]);
  });
});

describe("조치 칸에 맡은 작업을 단다", () => {
  const derive = (inputs: ActionInputs): DerivedStatus => ({ ...deriveStatus({ ...inputs, throughput: null }), workerProgress: brokenWorkerProgress() });
  const items = (() => { const inputs = brokenActionInputs(); return buildActions(inputs, derive(inputs)); })();
  const work = (key: string) => items.find((item) => item.key === key)?.work;

  it("장애·백로그 칸은 그 일을 하는 작업을, 역할·서비스 칸은 그 역할·서비스를 단다", () => {
    expect(work("down")).toEqual({ jobs: ["uptime-ping"] });
    expect(work("health-overdue")).toEqual({ jobs: ["uptime-ping"] });
    expect(work("review")?.jobs).toEqual(["crawl-agent-review", "second-review", "human-deepseek-review"]);
    expect(work("second-failed")).toEqual({ jobs: ["second-review"] });
    expect(work("repo-gone")).toEqual({ jobs: ["product-stars-refresh", "product-repo-review"] });
    expect(work("jobs")).toEqual({ jobs: ["product-evidence-refresh", "uptime-ping"] });
    // 진행 판정이 잡을 적지 않으면 그 단계(1차)의 잡, 실패율이 높은 모델 자리(2차 투표)는 그 자리를 부르는 잡
    expect(work("stage-progress")).toEqual({ jobs: ["crawl-agent-review"] });
    expect(work("model-failures")).toEqual({ jobs: ["second-review"] });
    expect(work("standby")).toEqual({ roles: ["maintenance"] });
    expect(work("held")).toEqual({ jobs: ["crawl-publish"], services: ["connect-agent"] });
    expect(work("web")).toEqual({ services: ["web"] });
    // 사람이 내려 달라고 한 요청은 맡은 작업이 없다
    expect(work("takedowns")).toBeUndefined();
  });
});

describe("맡은 장비·LLM·일정", () => {
  it("제작 근거 — 대기열을 채우는 M3 crawler 와 건 단위로 나눠 맡는 M3·Oracle consumer", () => {
    const owners = resolveWorkOwners({ jobs: ["agent-evidence-refresh"] }, context())!;
    expect(owners.hosts.map((host) => host.name)).toEqual(["M3", "Oracle"]);
    expect(owners.hosts[0].rows.map((row) => [row.instanceId, row.what, row.state, row.release])).toEqual([
      ["m3-crawler", "프로젝트 수집 역할 담당(주)", "지금 실행 중", "5ba60a1"],
      ["agent-scan-consumer-m3", "제작 근거 consumer(agent-scan)", "건 처리 중", "5ba60a1"],
    ]);
    expect(owners.hosts[1].rows.map((row) => [row.instanceId, row.state, row.release])).toEqual([["agent-scan-consumer-oracle", "대기", "6e452f8"]]);
    expect(owners.models).toEqual([]);
    expect(owners.jobs).toHaveLength(1);
    expect(owners.jobs[0]).toMatchObject({ label: "개발 AI 근거 갱신", role: "프로젝트 수집(crawler)", schedule: "1분마다",
      lane: "따로 도는 줄(scan) — 같은 역할의 다른 줄과 동시에", lastRun: expect.any(String), next: expect.any(String) });
    expect(owners.notes.some((note) => note.startsWith("일정은 cron 이 아니라 scheduler 앱"))).toBe(true);
    expect(owners.notes.some((note) => note.startsWith("consumer 는"))).toBe(true);
  });

  it("2차 심사 — 설정의 투표 모델(게이트웨이 실행기)과 켜진 Qwen 갈림 판가름, 그 서버를 장비로 보인다", () => {
    const owners = resolveWorkOwners({ jobs: ["second-review"] }, context())!;
    expect(owners.models.map((model) => model.name)).toEqual(["Qwen3.8-27B-NVFP4", "qwen3.8-flash-next"]);
    expect(owners.models[0].rows).toEqual([{ slot: "2차 · 투표 1", job: "2차 심사", provider: "abcllm", runsOn: "abcllm 게이트웨이 · 실행기 supa",
      source: "크롤 설정 secondReview.voters[0]", stats: "최근 1시간(2차 투표) 호출 34 · 실패 8" }]);
    expect(owners.models[1].rows[0]).toMatchObject({ slot: "2차 갈림 판가름", runsOn: "Qwen 직접 서버 gpu3090" });
    expect(owners.hosts.map((host) => host.name)).toEqual(["M3", "gpu3090"]);
    // 2차 consumer(ai2)는 관측되지 않았다 — 장비로 세지 않는다
    expect(owners.hosts[0].rows.map((row) => row.instanceId)).toEqual(["m3-reviewer"]);
  });

  it("발행 분류 — AI 연결 서비스의 우선·예비 모델과 그 서비스가 도는 장비", () => {
    const owners = resolveWorkOwners({ jobs: ["crawl-publish"], services: ["connect-agent"] }, context())!;
    expect(owners.models.map((model) => [model.name, model.rows[0].slot, model.rows[0].provider])).toEqual([
      ["gpt-5.6-terra", "분류 · 우선", "Codex 계정"], ["sonnet", "분류 · 예비", "Claude 계정"]]);
    expect(owners.models[0].full).toBe("gpt-5.6-terra · xhigh");
    expect(owners.hosts.flatMap((host) => host.rows.map((row) => `${host.name} ${row.instanceId}`))).toEqual(["M3 m3-publisher", "M3 m3-connect-agent"]);
    expect(owners.jobs.map((job) => job.name)).toEqual(["crawl-publish", "connect-agent"]);
  });

  it("예비가 일하는 역할은 mini 예비로, 지금 batch 방식에서 돌지 않는 작업은 빼고 보인다", () => {
    const owners = resolveWorkOwners({ jobs: ["uptime-ping", "product-site-evidence-refresh"] },
      context({ roles: [lease("maintenance", "mini-maintenance-standby", "standby")] }))!;
    expect(owners.hosts).toEqual([{ name: "mini", rows: [expect.objectContaining({ what: "생존 확인·지표 집계 역할 담당(예비)", tone: "warn" })] }]);
    expect(owners.jobs.map((job) => job.name)).toEqual(["uptime-ping"]);
  });

  it("X 수집기는 Oracle(osaka-smoke) 타이머, 맡은 것이 없으면 버튼을 달지 않는다", () => {
    expect(resolveWorkOwners({ services: ["x-collector"] }, context())?.hosts.map((host) => host.name)).toEqual(["Oracle"]);
    expect(resolveWorkOwners(undefined, context())).toBeNull();
    expect(workOwnersByAction([{ key: "a", work: { jobs: ["uptime-ping"] } }, { key: "b" }], context())).toHaveProperty("a");
    expect(workOwnersByAction([{ key: "b" }], context())).toEqual({});
  });
});

describe("칸의 버튼", () => {
  it("장비 이름과 LLM 이름이 버튼이고, 창은 누르기 전에는 그리지 않는다", () => {
    const owners = resolveWorkOwners({ jobs: ["agent-evidence-refresh", "second-review"] }, context())!;
    const item: SplitItem = { key: "x", tone: "hold", count: 3, unit: "건", title: "시험 칸", detail: "설명", trend: null, fresh: false };
    const html = renderToStaticMarkup(createElement(AttentionList, { urgent: [item], backlog: [], hidden: [], now: NOW, owners: { x: owners } }));
    const buttons = [...html.matchAll(/<button[^>]*class="dash-owner-btn"[^>]*data-kind="(\w+)"[^>]*>([^<]+)<\/button>/g)].map((match) => `${match[1]}:${match[2]}`);
    expect(buttons).toEqual(["host:M3", "host:Oracle", "host:gpu3090", "model:Qwen3.8-27B-NVFP4", "model:qwen3.8-flash-next"]);
    expect(html).not.toContain("<dialog");
    // 맡은 것을 모르는 칸에는 버튼 줄이 없다
    expect(renderToStaticMarkup(createElement(AttentionList, { urgent: [item], backlog: [], hidden: [], now: NOW }))).not.toContain("dash-owner");
  });
});

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { serviceInstancesFromObservations, supersededServiceInstanceKeys } from "@/lib/operations/instance";
import { splitServiceRoleRows } from "@/lib/operations/split-service-roles";
import type { OperationJob } from "@/app/(operator)/admin/status/OperationsCenter";

// 역할 관측 정리(v8 PR7). 재배포 뒤 옛 boot·옛 릴리스의 서비스 키가 1시간 동안 "일부 관측 지연"을 냈다(scheduler 키 66개 중 1시간 안 옛 키 2개).
// 새 boot·새 릴리스가 이어받은 옛 인스턴스는 지연 판정에서 빼되, 살아 있어야 할 자리가 모자라면 가장 최근의 옛 인스턴스는 지연으로 남긴다.
// 분리 역할(translation·product-health·site-evidence·official-news) 행은 versioned 이거나 후보가 있을 때만 보이고, 기존 방식에서는 경보하지 않는다.
const params = vi.hoisted(() => ({ value: "tab=diagnostics" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), useSearchParams: () => new URLSearchParams(params.value) }));
vi.mock("@/app/(operator)/admin/status/actions", () => ({ requestOperation: vi.fn(), setCollectionEnabled: vi.fn() }));

const NOW = Date.parse("2026-10-18T08:44:16.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN;
type Row = { key: string; value: Record<string, unknown>; observedAt: string };
const service = (key: string, observed: number, booted: number, release: string, extra: Record<string, unknown> = {}): Row =>
  ({ key, value: { status: "running", bootedAt: NOW - booted, release, ...extra }, observedAt: ago(observed) });

/** 운영 scheduler 키 66개 모양: 1시간 넘은 옛 배포 키 62개, 방금 재배포로 멈춘 옛 boot 2개, 새 boot 2개 */
function schedulerKeys66(): Row[] {
  const old = Array.from({ length: 62 }, (_, i) => service(`service:scheduler:m3-scheduler-${(0x100000000000 + i).toString(16)}`,
    2 * HOUR + i * 9 * HOUR, 3 * HOUR + i * 9 * HOUR, `old${i % 7}`));
  return [...old,
    service("service:scheduler:m3-scheduler-aaaaaaaaaaa1", 21 * MIN, 5 * HOUR, "r1"),
    service("service:scheduler:m3-scheduler-aaaaaaaaaaa2", 21 * MIN, 5 * HOUR, "r1"),
    service("service:scheduler:m3-scheduler-bbbbbbbbbbb1", 5_000, 21 * MIN, "r2"),
    service("service:scheduler:m3-scheduler-bbbbbbbbbbb2", 9_000, 21 * MIN, "r2"),
  ];
}
const superseded = (rows: Row[]) => [...supersededServiceInstanceKeys(serviceInstancesFromObservations(rows), NOW)].sort();

describe("superseded boots", () => {
  it("drops the previous boots of both scheduler replicas once two new replicas are fresh (66-key fixture)", () => {
    const keys = superseded(schedulerKeys66());
    expect(keys).toContain("service:scheduler:m3-scheduler-aaaaaaaaaaa1");
    expect(keys).toContain("service:scheduler:m3-scheduler-aaaaaaaaaaa2");
    expect(keys).not.toContain("service:scheduler:m3-scheduler-bbbbbbbbbbb1");
    expect(keys).not.toContain("service:scheduler:m3-scheduler-bbbbbbbbbbb2");
  });

  it("drops boots replaced twice within the hour too, when both replica slots are fresh", () => {
    const rows = [service("service:scheduler:m3-scheduler-a1", 50 * MIN, 2 * HOUR, "r0"), service("service:scheduler:m3-scheduler-a2", 50 * MIN, 2 * HOUR, "r0"),
      service("service:scheduler:m3-scheduler-b1", 20 * MIN, 50 * MIN, "r1"), service("service:scheduler:m3-scheduler-b2", 20 * MIN, 50 * MIN, "r1"),
      service("service:scheduler:m3-scheduler-c1", 3_000, 20 * MIN, "r2"), service("service:scheduler:m3-scheduler-c2", 3_000, 20 * MIN, "r2")];
    expect(superseded(rows)).toEqual(["service:scheduler:m3-scheduler-a1", "service:scheduler:m3-scheduler-a2",
      "service:scheduler:m3-scheduler-b1", "service:scheduler:m3-scheduler-b2"]);
  });

  it("keeps a genuinely missing scheduler replica: one new replica cannot replace both old ones", () => {
    const rows = [service("service:scheduler:m3-scheduler-a1", 21 * MIN, 5 * HOUR, "r1"), service("service:scheduler:m3-scheduler-a2", 22 * MIN, 5 * HOUR, "r1"),
      service("service:scheduler:m3-scheduler-b1", 5_000, 21 * MIN, "r2")];
    // 모자란 한 자리만큼 가장 최근에 본 옛 replica(a1)는 지연으로 남는다
    expect(superseded(rows)).toEqual(["service:scheduler:m3-scheduler-a2"]);
  });

  it("keeps a replica that died without a newer boot replacing it", () => {
    const rows = [service("service:scheduler:m3-scheduler-a1", 5_000, 2 * HOUR, "r1"), service("service:scheduler:m3-scheduler-a2", 10 * MIN, 2 * HOUR, "r1")];
    expect(superseded(rows)).toEqual([]);
  });

  it("drops the standby's stale boot after the primary took the role back with a newer boot", () => {
    const rows = [service("service:publisher:m3-publisher", 4_000, 30 * MIN, "r2"), service("service:publisher:mini-publisher-standby", 31 * MIN, 40 * MIN, "r2")];
    expect(superseded(rows)).toEqual(["service:publisher:mini-publisher-standby"]);
  });

  it("drops an old-release boot even when its boot clock reads later (newer release), but not a same-release one", () => {
    const skewed = (release: string) => [service("service:publisher:m3-publisher", 4_000, 30 * MIN, "r2"),
      service("service:publisher:mini-publisher-standby", 29 * MIN, 29 * MIN, release)];
    expect(superseded(skewed("r1"))).toEqual(["service:publisher:mini-publisher-standby"]);
    expect(superseded(skewed("r2"))).toEqual([]);
    expect(superseded(skewed("unknown"))).toEqual([]);
  });

  it("never hides a role with no fresh instance, and never lets one web instance stand in for the other", () => {
    expect(superseded([service("service:publisher:m3-publisher", 5 * MIN, 30 * MIN, "r2"),
      service("service:publisher:mini-publisher-standby", 31 * MIN, 40 * MIN, "r1")])).toEqual([]);
    expect(superseded([service("service:app:m3-web", 3_000, 10 * MIN, "r2"), service("service:app:mini-web", 30 * MIN, 2 * HOUR, "r1")])).toEqual([]);
  });
});

describe("split service roles", () => {
  const candidate = (role: string, observed: number): Row => ({ key: `candidate:${role}:oracle-osaka-${role}`,
    value: { role, kind: "primary", phase: "standby" }, observedAt: ago(observed) });

  it("shows none in legacy without candidates, all four (alarming) in versioned", () => {
    expect(splitServiceRoleRows({ batchMode: "legacy", observations: [], now: NOW })).toEqual([]);
    const rows = splitServiceRoleRows({ batchMode: "versioned", observations: [], now: NOW });
    expect(rows.map(row => [row.role, row.alarms])).toEqual([["translation", true], ["product-health", true], ["site-evidence", true], ["official-news", true]]);
    expect(rows.find(row => row.role === "translation")?.jobs).toEqual(["reason-translate", "product-tagline-ko", "product-translate"]);
  });

  it("shows a role with a candidate or service seen within the hour, without alarming outside versioned", () => {
    const observations = [candidate("translation", 10_000), candidate("official-news", 2 * HOUR),
      { key: "service:site-evidence:oracle-osaka-site-evidence", value: {}, observedAt: ago(5 * MIN) }];
    expect(splitServiceRoleRows({ batchMode: "legacy", observations, now: NOW }).map(row => [row.role, row.alarms]))
      .toEqual([["translation", false], ["site-evidence", false]]);
    expect(splitServiceRoleRows({ batchMode: "draining", observations, now: NOW }).every(row => !row.alarms)).toBe(true);
  });
});

describe("operations center: service observation rows", () => {
  async function render(rows: Row[], splitRoles: ReturnType<typeof splitServiceRoleRows> = [], query = "tab=diagnostics", jobs: OperationJob[] = []) {
    params.value = query;
    const { OperationsCenter } = await import("@/app/(operator)/admin/status/OperationsCenter");
    const data = { fetchedAt: new Date(NOW).toISOString(), observations: rows, serviceInstances: serviceInstancesFromObservations(rows),
      dbLatencyMs: 3, audit: [], held: 0, heldNextRetryAt: null };
    return renderToStaticMarkup(<OperationsCenter jobs={jobs} data={data} reviewMode="first" enabled attention={null} dashboard={null}
      statusChips={null} diagnostics={null} manual={null} crawlers={null} splitRoles={splitRoles} />);
  }
  const rowState = (html: string, label: string) => new RegExp(`data-state="(\\w+)"[^>]*>(?:<[^>]+>)*${label}`).exec(html)?.[1];
  const live = [service("service:crawler:m3-crawler", 3_000, HOUR, "r2"), service("service:reviewer:m3-reviewer", 3_000, HOUR, "r2"),
    service("service:publisher:m3-publisher", 4_000, 30 * MIN, "r2"), service("service:publisher:mini-publisher-standby", 31 * MIN, 40 * MIN, "r2"),
    service("service:text:m3-text", 3_000, HOUR, "r2"), service("service:maintenance:m3-maintenance", 3_000, HOUR, "r2"),
    service("service:app:m3-web", 3_000, HOUR, "r2"), service("service:app:mini-web", 3_000, HOUR, "r2"),
    service("service:connect-agent:m3-connect-agent", 3_000, HOUR, "r2")];

  it("after a redeploy the scheduler and publisher rows are not delayed by superseded boots", async () => {
    const html = await render([...schedulerKeys66(), ...live]);
    expect(rowState(html, "작업 일정 관리")).toBe("ok");
    expect(rowState(html, "제품 발행")).toBe("ok");
    expect(html).toContain("서비스 관측 <small>9/9 정상</small>");
    // 표의 대수·마지막 관측 칸은 지금과 같다(1시간 안 키 4개)
    expect(html).toMatch(/작업 일정 관리[^]*?<td class="n">4대<\/td>/);
    const dialog = await render([...schedulerKeys66(), ...live], [], "tab=diagnostics&worker=scheduler");
    expect(dialog).toContain('<span class="ops-badge">실행 관측</span>');
  });

  it("still shows a genuinely missing scheduler replica as partly delayed", async () => {
    const rows = [...schedulerKeys66().filter(row => !row.key.endsWith("bbbbbbbbbbb2")), ...live];
    expect(rowState(await render(rows), "작업 일정 관리")).toBe("delayed");
    expect(await render(rows, [], "tab=diagnostics&worker=scheduler")).toContain('<span class="ops-badge">일부 관측 지연 · 1개</span>');
  });

  it("adds split-role rows only when given; legacy rows wait without alarming, versioned rows alarm when unobserved", async () => {
    const base = [...schedulerKeys66(), ...live];
    const without = await render(base);
    expect(without).toContain("서비스 관측 <small>9/9 정상</small>");
    expect(without).not.toContain(">번역<");
    const legacy = splitServiceRoleRows({ batchMode: "legacy", now: NOW, observations: [{ key: "candidate:translation:oracle-osaka-translation", observedAt: ago(10_000) }] });
    const idle = await render(base, legacy);
    expect(rowState(idle, "번역")).toBe("idle");
    // 기존 방식의 대기는 경보가 아니다 — 정상 수에 든다
    expect(idle).toContain("서비스 관측 <small>10/10 정상</small>");
    expect(await render(base, legacy, "tab=diagnostics&worker=translation")).toContain('<span class="ops-badge">대기 · 기존 방식(legacy)</span>');
    const versioned = await render(base, splitServiceRoleRows({ batchMode: "versioned", observations: [], now: NOW }));
    expect(rowState(versioned, "번역")).toBe("delayed");
    expect(rowState(versioned, "AI 소식 수집")).toBe("delayed");
    expect(versioned).toContain("서비스 관측 <small>9/13 정상</small>");
    // 기존 행의 순서는 그대로, 분리 역할은 맨 뒤
    expect(versioned.indexOf("AI 연결·분류 실행")).toBeLessThan(versioned.indexOf(">번역<"));
    // 상세 창의 담당 작업은 그 분리 역할의 versioned 잡이다(카탈로그 역할 text 가 아니라)
    const job = (name: string): OperationJob => ({ name, status: "대기", lastRunAt: null, lastSuccessAt: null, nextScheduledAt: null, notBefore: null,
      workerSeenAt: null, requestedVersion: 0, processedVersion: 0, runs: 0, lastError: null, cursor: "null" });
    const dialog = await render(base, splitServiceRoleRows({ batchMode: "versioned", observations: [], now: NOW }), "tab=diagnostics&worker=translation",
      [job("reason-translate"), job("crawl-tagline")]);
    expect(dialog).toContain("<code>reason-translate</code>");
    expect(dialog).not.toContain("<code>crawl-tagline</code>");
  });
});

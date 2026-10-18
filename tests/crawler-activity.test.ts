import { describe, expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { NEWS_SOURCE_KEYS } from "@/lib/news/sources";
import { buildCrawlerActivity, COLLECTOR_JOBS, type CollectorJobInput } from "@/lib/operations/crawler-activity";

const now = new Date("2026-10-14T03:00:00Z");
const fresh = new Date(now.getTime() - 5_000);
const old = new Date(now.getTime() - 120_000);
const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } };
const job = (name: string, patch: Partial<CollectorJobInput> = {}): CollectorJobInput => ({ name,
  lastRunAt: old, lastSuccessAt: old, notBefore: null, nextScheduledAt: new Date(now.getTime() + 60_000),
  lockedAt: null, leaseToken: null, requestedVersion: 2, processedVersion: 2, lastError: null, runs: 2, ...patch });
const observation = (key: string, value: Record<string, unknown>, observedAt = fresh) => ({ key, value, observedAt });
const lane = (name: string, jobs: string[], currentJob: string | null) => ({ name, jobs,
  state: currentJob ? "running" : "idle", currentJob, startedAt: currentJob ? fresh.getTime() : null,
  pollStartedAt: null, lastProgressAt: fresh.getTime() });
const build = (patch: Partial<Parameters<typeof buildCrawlerActivity>[0]> = {}) => buildCrawlerActivity({
  now, settings, jobs: [], observations: [], roles: [], throughput: null, ...patch });

describe("catalog collector coverage", () => {
  it("includes every crawler catalog entry and external collectors without review/publish/text generation", () => {
    expect(COLLECTOR_JOBS.map(row => row.name)).toEqual(JOB_CATALOG.filter(row => row.role === "crawler" ||
      ["uptime-ping", "news-refresh", "product-thumbnail-refresh", "product-repo-review"].includes(row.name)).map(row => row.name));
    const report = build();
    expect(report.jobs).toHaveLength(COLLECTOR_JOBS.length);
    expect(report.jobs.map(row => row.name)).not.toContain("product-intro-check");
    expect(report.jobs.map(row => row.name)).not.toContain("crawl-publish");
    expect(report.jobs.find(row => row.name === "product-repo-review")?.note).toContain("내릴 수");
  });

  it("distinguishes disabled, paused, retrying, queued, never-run, running and stale-lock states", () => {
    const rows = build({ jobs: [
      job("crawl-fetch", { lockedAt: fresh, leaseToken: "secret-lease" }),
      job("product-readme-refresh", { notBefore: new Date("2100-01-01") }),
      job("product-stars-refresh", { notBefore: new Date(now.getTime() + 30_000), lastError: "token-secret upstream" }),
      job("product-star-observation", { requestedVersion: 3 }),
      job("ai-level-refresh", { lockedAt: old, leaseToken: "secret-lease" }),
    ], settings: { ...settings, discover: { ...settings.discover, showHn: { ...settings.discover.showHn, enabled: false } } } }).jobs;
    const state = (name: string) => rows.find(row => row.name === name)?.state;
    expect(state("crawl-fetch")).toBe("running");
    expect(state("product-readme-refresh")).toBe("paused");
    expect(state("product-stars-refresh")).toBe("retrying");
    expect(state("product-star-observation")).toBe("queued");
    expect(state("ai-level-refresh")).toBe("stale-lock");
    expect(state("hn-show-seed")).toBe("disabled");
    expect(state("news-refresh")).toBe("never-run");
    expect(build({ settings: { ...settings, enabled: false } }).jobs.find(row => row.name === "crawl-fetch")?.state).toBe("disabled");
    expect(build({ settings: { ...settings, enabled: false } }).jobs.find(row => row.name === "uptime-ping")?.state).toBe("never-run");
  });

  it("keeps failed ticks and provider backoff visible without exposing arbitrary error or cursor contents", () => {
    const report = build({ jobs: [job("crawl-seed", { lastError: "Authorization Bearer top-secret timeout" }),
      job("agent-evidence-refresh", { cursor: { retryAfter: "2026-10-14T03:01:00Z", secret: "cursor-secret" } })] });
    expect(report.jobs.find(row => row.name === "crawl-seed")).toMatchObject({ state: "error", error: "timeout" });
    expect(report.jobs.find(row => row.name === "agent-evidence-refresh")).toMatchObject({ state: "retrying", retryAt: "2026-10-14T03:01:00.000Z" });
    expect(JSON.stringify(report)).not.toMatch(/top-secret|cursor-secret|Authorization|lastError|leaseToken|"cursor"/);
  });

  it("does not turn successful ticks or missing metrics into zero waiting", () => {
    const report = build({ throughput: { measuredAt: now.toISOString(), stages: [{ key: "fetch", waiting: 0, deferred: 9 }] },
      observations: [observation("job:news-refresh", { done: true, events: [] })] });
    expect(report.jobs.find(row => row.name === "crawl-fetch")).toMatchObject({ waiting: 0, deferred: 9 });
    expect(report.jobs.find(row => row.name === "news-refresh")).toMatchObject({ waiting: null, deferred: null });
    expect(build().jobs.find(row => row.name === "crawl-fetch")?.waiting).toBeNull();
  });

  it("shows in-flight work separately from disabled configuration and preserves provider waits for all supported cursors", () => {
    const report = build({ settings: { ...settings, enabled: false, news: { ...settings.news, disabledSources: [...NEWS_SOURCE_KEYS] } }, jobs: [
      job("crawl-fetch", { lockedAt: fresh, leaseToken: "secret-lock" }),
      ...["crawl-seed", "product-stars-refresh", "product-star-observation"].map(name => job(name, { cursor: {
        retryAt: name === "crawl-seed" ? "2026-10-14T03:04:00Z" : undefined,
        retryAfter: name !== "crawl-seed" ? "2026-10-14T03:04:00Z" : undefined, secret: "secret-cursor",
      } })),
    ] });
    expect(report.jobs.find(row => row.name === "crawl-fetch")).toMatchObject({ state: "running", enabled: false });
    expect(report.jobs.find(row => row.name === "news-refresh")?.state).toBe("disabled");
    for (const name of ["crawl-seed", "product-stars-refresh", "product-star-observation"])
      expect(report.jobs.find(row => row.name === name)?.retryAt).toBe("2026-10-14T03:04:00.000Z");
    expect(JSON.stringify(report)).not.toContain("secret-cursor");
  });
});

describe("instance and lane activity", () => {
  it("uses the lease owner rather than the newest standby and retains every simultaneous lane", () => {
    const report = build({ roles: [{ role: "crawler", ownerInstanceId: "m3-crawler", secondsUntilExpiry: 30 }], observations: [
      observation("candidate:crawler:m3-crawler", { kind: "primary", phase: "active" }),
      observation("service:crawler:m3-crawler", { status: "running", release: "45de7d0", lanes: [
        lane("crawl-seed", ["crawl-seed", "crawl-fetch"], "crawl-fetch"),
        lane("agent-evidence-refresh", ["agent-evidence-refresh"], "agent-evidence-refresh"),
        lane("ai-level-refresh", ["ai-level-refresh"], "ai-level-refresh"),
      ] }),
      observation("candidate:crawler:mini-crawler-standby", { kind: "standby", phase: "standby" }, now),
      observation("service:crawler:old-crawler", { status: "running", lanes: [lane("crawl-seed", ["crawl-seed"], "crawl-seed")] }, old),
    ] });
    expect(report.instances.find(row => row.instanceId === "m3-crawler")).toMatchObject({ state: "active", kind: "primary" });
    expect(report.instances.find(row => row.instanceId === "mini-crawler-standby")).toMatchObject({ state: "standby", kind: "standby" });
    expect(report.instances.find(row => row.instanceId === "m3-crawler")?.lanes.filter(row => row.state === "running")).toHaveLength(3);
    expect(report.instances.find(row => row.instanceId === "mini-crawler-standby")?.lanes.every(row => row.state === "standby")).toBe(true);
    expect(report.instances.find(row => row.instanceId === "old-crawler")?.lanes.every(row => row.state !== "running")).toBe(true);
    expect(report.instances.find(row => row.instanceId === "old-crawler")?.state).toBe("stale");
  });

  it("labels absent lease authority and stale runtime separately, without promoting old running metadata", () => {
    const report = build({ roles: null, observations: [
      observation("candidate:crawler:m3-crawler", { kind: "primary", phase: "active", secret: "candidate-secret" }),
      observation("service:crawler:m3-crawler", { status: "running", release: "Bearer release-secret", lanes: [lane("crawl-seed", ["crawl-seed"], "crawl-seed")] }, old),
    ] });
    expect(report.instances[0]).toMatchObject({ state: "unknown", runtimeStale: true, release: null });
    expect(report.instances[0].lanes.every(row => row.state !== "running")).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/candidate-secret|release-secret/);
  });

  it("does not collapse same lane names across separate fresh instances", () => {
    const report = build({ observations: ["m3-crawler", "mini-crawler-standby"].flatMap(id => [
      observation(`candidate:crawler:${id}`, { phase: "standby", kind: id.startsWith("m3") ? "primary" : "standby" }),
      observation(`service:crawler:${id}`, { status: "running", lanes: [lane("crawl-seed", ["crawl-seed"], null)] }),
    ]) });
    expect(report.instances).toHaveLength(2);
    expect(report.instances.every(row => row.lanes.some(value => value.name === "main"))).toBe(true);
  });

  it.each([
    { phase: "standby", candidateAgeMs: 55_000, owner: "m3-crawler", expiry: 30, state: "active" },
    { phase: "stopping", candidateAgeMs: 55_000, owner: "m3-crawler", expiry: 30, state: "active" },
    { phase: "standby", candidateAgeMs: 0, owner: "m3-crawler", expiry: 30, state: "standby" },
    { phase: "stopping", candidateAgeMs: 0, owner: "m3-crawler", expiry: 30, state: "stopping" },
    { phase: "standby", candidateAgeMs: 1_000, owner: "m3-crawler", expiry: 30, state: "standby" },
    { phase: "standby", candidateAgeMs: 55_000, owner: "mini-crawler-standby", expiry: 30, state: "standby" },
    { phase: "standby", candidateAgeMs: 55_000, owner: "m3-crawler", expiry: 0, state: "standby" },
  ])("reconciles $phase at age $candidateAgeMs with a newer runtime and lease owner $owner/$expiry", ({ phase, candidateAgeMs, owner, expiry, state }) => {
    const report = build({ roles: [{ role: "crawler", ownerInstanceId: owner, secondsUntilExpiry: expiry }], observations: [
      observation("candidate:crawler:m3-crawler", { kind: "primary", phase, release: "1111111" }, new Date(now.getTime() - candidateAgeMs)),
      observation("service:crawler:m3-crawler", { status: "running", release: "2222222", lanes: [
        lane("crawl-seed", ["crawl-seed", "crawl-fetch"], "crawl-fetch"),
        lane("agent-evidence-refresh", ["agent-evidence-refresh"], "agent-evidence-refresh"),
      ] }, new Date(now.getTime() - 1_000)),
    ] });
    expect(report.instances[0].state).toBe(state);
    expect(report.instances[0].lanes.filter(row => row.state === "running")).toHaveLength(state === "active" ? 2 : 0);
    expect(report.instances[0].release).toBe(candidateAgeMs > 1_000 ? "2222222" : "1111111");
  });
});

describe("safe bounded latest results", () => {
  it("filters noncollector observations before limiting and strips arbitrary names, payloads and numeric identifiers", () => {
    const report = build({ jobs: [job("news-refresh")], observations: [
      ...Array.from({ length: 80 }, (_, i) => observation(`job:unrelated-${i}`, { events: [] }, now)),
      observation("job:news-refresh", { durationMs: 1400, done: true, token: "payload-secret", events: [
        { event: "news.refreshed", counts: { added: 3, failed: 2, secret: 123, productId: 234, invalid: Infinity }, detail: "detail-secret" },
        { event: "event-secret", counts: { checked: 999 } },
      ] }, old),
    ] });
    expect(report.recent).toHaveLength(1);
    expect(report.recent[0]).toMatchObject({ name: "news-refresh", durationMs: 1400, outcome: "item-errors" });
    expect(report.recent[0].events[0].counts).toEqual({ added: 3, failed: 2 });
    expect(JSON.stringify(report)).not.toMatch(/payload-secret|detail-secret|event-secret|productId|"secret"|999/);
  });

  it("does not call unreported item errors zero, and retains numeric zero when reported", () => {
    const report = build({ observations: [observation("job:product-readme-refresh", { events: [{ event: "readme_refresh.done", counts: { refreshed: 0, failed: 0 } }] }),
      observation("job:ai-level-refresh", { events: [{ event: "ai_level.tick", counts: { checked: 0, due: 0 } }] })] });
    expect(report.recent.find(row => row.name === "product-readme-refresh")?.itemErrors).toBe(0);
    expect(report.recent.find(row => row.name === "ai-level-refresh")?.itemErrors).toBeNull();
    expect(report.jobs.find(row => row.name === "product-intro-check")).toBeUndefined();
    expect(report.x).toMatchObject({ state: "manual-pilot", scheduled: false, lastRunAt: null });
  });

  it("rejects inherited event keys and malformed counters without disrupting the dashboard", () => {
    const report = build({ observations: [observation("job:news-refresh", { durationMs: -1, events: [
      { event: "constructor", counts: { added: 1 } }, { event: "__proto__", counts: {} },
      { event: "news.refreshed", counts: { added: NaN, failed: -1, unfinished: true, token: 30 } },
    ] })] });
    expect(report.recent[0].durationMs).toBeNull();
    expect(report.recent[0].events).toEqual([{ label: "소식 수집 결과", counts: { unfinished: true } }]);
    expect(report.recent[0].itemErrors).toBeNull();
  });

  it("uses the latest aggregate failure count without double counting per-item events", () => {
    const report = build({ observations: [observation("job:product-evidence-refresh", { events: [
      { event: "evidence.product_refresh_failed", counts: { productId: 4 } },
      { event: "evidence.refresh_batch", counts: { attempted: 2, failed: 1 } },
      { event: "evidence.refresh_batch", counts: { attempted: 3, failed: 1 } },
    ] })] });
    expect(report.recent[0]).toMatchObject({ itemErrors: 1, errorEvents: 1, outcome: "item-errors" });
  });

  it("distinguishes sampled error events and boolean provider failures from item totals", () => {
    const report = build({ observations: [
      observation("job:product-stars-refresh", { events: [{ event: "product_stars.refreshed", counts: { examined: 50, failed: true } }] }),
      observation("job:crawl-seed", { events: [{ event: "crawl.seed_failed", counts: { page: 1 } }] }),
    ] });
    expect(report.recent.find(row => row.name === "product-stars-refresh")).toMatchObject({ itemErrors: null, providerError: true, outcome: "provider-error" });
    expect(report.recent.find(row => row.name === "crawl-seed")).toMatchObject({ itemErrors: null, errorEvents: 1, outcome: "event-errors" });
  });

  it("keeps exact repository-review emitter counters and projects safe unresolved provider categories", () => {
    const report = build({ jobs: [job("agent-evidence-refresh", { cursor: { providerFailure: { repositoryKey: "private/context", code: "rate_limited",
      firstFailureAt: old.toISOString(), lastFailureAt: fresh.toISOString(), failures: 2 } } })], observations: [
      observation("job:product-repo-review", { events: [{ event: "repo_review.reviewed", counts: {
        keep: 2, human: 1, delist_candidate: 1, delisted: 1, capped: 0, operatorKeep: 0, unknown: 2,
      } }] }),
    ] });
    expect(report.recent[0].events[0].counts).toEqual({ keep: 2, human: 1, delist_candidate: 1, delisted: 1, capped: 0, operatorKeep: 0, unknown: 2 });
    expect(report.jobs.find(row => row.name === "agent-evidence-refresh")?.error).toBe("rate-limited");
    expect(JSON.stringify(report)).not.toContain("private/context");
  });

  it("projects persisted scan failure flags without inventing an item error total", () => {
    const report = build({ observations: [observation("job:agent-evidence-refresh", { events: [
      { event: "agent_evidence.scanned", counts: { scanId: 42, observations: 0, cached: false, failed: true } },
    ] })] });
    expect(report.recent[0]).toMatchObject({ outcome: "provider-error", providerError: true, itemErrors: null });
    expect(report.recent[0].events[0].counts).toEqual({ observations: 0, cached: false, failed: true });
    expect(JSON.stringify(report)).not.toContain("scanId");
  });

  it("keeps older scan observations unknown unless the safe failure flag was recorded", () => {
    const legacy = build({ observations: [observation("job:agent-evidence-refresh", { events: [
      { event: "agent_evidence.scanned", counts: { observations: 0, cached: false } },
    ] })] });
    expect(legacy.recent[0]).toMatchObject({ outcome: "unknown", itemErrors: null });
    const current = build({ observations: [observation("job:agent-evidence-refresh", { events: [
      { event: "agent_evidence.scanned", counts: { observations: 0, cached: false, failed: false } },
    ] })] });
    expect(current.recent[0]).toMatchObject({ outcome: "completed", itemErrors: null });
  });

  it("surfaces an uptime tick whose failures were held as a broad failure", () => {
    const report = build({ observations: [observation("job:uptime-ping", { events: [
      { event: "uptime.broad_failure_held", counts: { attempted: 50, down: 40 } },
      { event: "uptime.checked", counts: { alive: 10, down: 40, autoBanned: 0 } },
    ] })] });
    expect(report.recent[0]).toMatchObject({ name: "uptime-ping", errorEvents: 1, outcome: "event-errors" });
    expect(report.recent[0].events[0]).toEqual({ label: "응답 점검 광역 실패 보류", counts: { attempted: 50, down: 40 } });
  });

  it("shows split claims applying submitted results and a breaker that stops home checks", () => {
    const report = build({ observations: [observation("job:uptime-ping", { events: [
      { event: "uptime.split_applied", counts: { remote: 12, applied: 9, held: 0, confirmRequested: 3, returned: 0, stale: 0, lost: 0, discarded: 0 } },
      { event: "uptime.split_blocked", counts: { breakerOpen: 1, unconfigured: 0, fenced: 0 } },
    ] })] });
    expect(report.recent[0]).toMatchObject({ name: "uptime-ping", errorEvents: 1, outcome: "event-errors" });
    expect(report.recent[0].events.map(event => event.label)).toEqual(["응답 점검 제출분 반영", "응답 점검 분담 확인 멈춤"]);
    expect(report.recent[0].events[0].counts).toMatchObject({ remote: 12, applied: 9, confirmRequested: 3 });
  });

  it("shows bot- or login-blocked uptime responses as unknown beside alive and down", () => {
    const report = build({ observations: [observation("job:uptime-ping", { events: [
      { event: "uptime.broad_failure_held", counts: { attempted: 30, down: 10, unknown: 20 } },
      { event: "uptime.checked", counts: { alive: 140, down: 2, unknown: 1, autoBanned: 0 } },
    ] })] });
    expect(report.recent[0].events).toEqual([
      { label: "응답 점검 광역 실패 보류", counts: { attempted: 30, down: 10, unknown: 20 } },
      { label: "서비스 응답 결과", counts: { alive: 140, down: 2, unknown: 1 } },
    ]);
  });

  it("preserves independent request errors beside an authoritative zero failed-item total", () => {
    const report = build({ observations: [observation("job:product-evidence-refresh", { events: [
      { event: "evidence.initial_refresh_queue_failed", counts: {} },
      { event: "evidence.refresh_batch", counts: { attempted: 0, failed: 0 } },
    ] })] });
    expect(report.recent[0]).toMatchObject({ itemErrors: 0, errorEvents: 1, outcome: "event-errors" });
  });
});

// 리뷰 P3(agent-scan 9·uptime F8): consumer 는 역할 lease·후보가 없다 — '담당 여부 미확인' 역할 인스턴스로 섞이지 않고 consumer 줄로 보인다
describe("consumer instances", () => {
  it("lists agent-scan and uptime consumers as their own kind without role lanes", () => {
    const report = build({ roles: [{ role: "crawler", ownerInstanceId: "m3-crawler", secondsUntilExpiry: 30 }], observations: [
      observation("candidate:crawler:m3-crawler", { kind: "primary", phase: "active" }),
      observation("service:crawler:m3-crawler", { status: "running", lanes: [lane("crawl-seed", ["crawl-seed", "crawl-fetch"], null)] }),
      observation("service:crawler:agent-scan-consumer-m3", { status: "running", release: "45de7d0" }),
      observation("service:crawler:agent-scan-consumer-oracle", { status: "running" }, old),
      observation("service:maintenance:uptime-consumer-oracle", { status: "running" }),
    ] });
    expect(report.instances.find(row => row.instanceId === "agent-scan-consumer-m3"))
      .toEqual({ instanceId: "agent-scan-consumer-m3", role: "crawler", kind: "consumer", state: "active", observedAt: fresh.toISOString(),
        runtimeStale: false, release: "45de7d0", lanes: [] });
    expect(report.instances.find(row => row.instanceId === "agent-scan-consumer-oracle")).toMatchObject({ kind: "consumer", state: "stale", lanes: [] });
    expect(report.instances.find(row => row.instanceId === "uptime-consumer-oracle")).toMatchObject({ role: "maintenance", kind: "consumer", state: "active" });
    expect(report.instances.find(row => row.instanceId === "m3-crawler")).toMatchObject({ kind: "primary", state: "active" });
  });
});

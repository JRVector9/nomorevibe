import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollectorTotalsDetail, CrawlerActivity } from "@/app/(operator)/admin/status/CrawlerActivity";
import { buildCrawlerActivity } from "@/lib/operations/crawler-activity";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { STATUS_TABS } from "@/app/(operator)/admin/status/action-links";
import { readXStatus, X_STATUS_KEY } from "@/lib/operations/x-status";

const now = new Date("2026-10-14T03:00:00Z");
const report = () => buildCrawlerActivity({ settings: { ...DEFAULT_CRAWL_SETTINGS, enabled: true }, jobs: [], observations: [],
  roles: [], throughput: null, now });
const html = (value = report()) => renderToStaticMarkup(createElement(CrawlerActivity, { report: value }));

describe("read-only collector activity", () => {
  it("X 칸은 흐름 상세와 같은 readXStatus·xSummary 로 실제 상태를 보인다 — 매일 09:10 KST 자동 수집, 검색어는 보고(v3)에서", () => {
    const record = { v: 3, mode: "live", reads: { used: 10, limit: 10 }, candidates: 4, lastRunAt: "2026-10-14T00:10:01.000Z",
      lastSuccessAt: "2026-10-14T00:10:01.000Z", error: null, query: { source: "popular", minLikes: 50 }, sentAt: Math.floor(Date.parse("2026-10-14T00:10:05.000Z") / 1000), signedWith: "current" };
    const ok = renderToStaticMarkup(createElement(CrawlerActivity, { report: report(),
      x: readXStatus([{ key: X_STATUS_KEY, value: record, observedAt: "2026-10-14T00:10:05.000Z" }], now, true) }));
    expect(ok).toContain("X 후보 4");
    expect(ok).toContain('data-tone="ok"');
    expect(ok).toContain("매일 09:10 KST");
    expect(ok).toContain("url:github.com min_likes:50");
    expect(ok).toContain("실제 수집(live)");
    expect(ok).not.toContain("수동 API 파일럿");
    // 26시간 넘게 보고가 없으면 끊김(주황) — X 보고 끊김 조치가 여기로 링크한다
    const stale = renderToStaticMarkup(createElement(CrawlerActivity, { report: report(),
      x: readXStatus([{ key: X_STATUS_KEY, value: record, observedAt: "2026-10-12T00:10:05.000Z" }], now, true) }));
    expect(stale).toContain("X 보고 끊김(stale)");
    expect(stale).toMatch(/<h2>X<\/h2><span class="crawler-state" data-tone="warn">/);
  });

  it("renders every collector with never-run and unknown waiting states, and the X collector as its own card", () => {
    const out = html();
    expect(out).toContain("수집 대상 탐색");
    expect(out).toContain("Show HN 수집");
    expect(out).toContain("AI 제작 단계 확인");
    expect(out).toContain("README 갱신");
    expect(out).toContain("프로젝트 이미지 수집");
    expect(out).toContain("저장소 사라진 사이트 확인");
    expect(out).toContain("실행 기록 없음");
    expect(out).toContain("대기 미확인");
    // X 는 2026-10-20부터 매일 자동 수집한다 — 옛 "자동 수집 안 함 · 수동 API 파일럿" 글이 남지 않는다
    expect(out).not.toContain("자동 수집 안 함");
    expect(out).not.toContain("수동 API 파일럿");
    expect(out).toContain("보고 미확인");
    expect(out).not.toContain("작업 실행 요청");
    expect(out).not.toContain("product-intro-check");
  });

  it("explains latest-only result storage and exposes safe results plus item errors", () => {
    const value = buildCrawlerActivity({ settings: DEFAULT_CRAWL_SETTINGS, jobs: [], roles: [], throughput: null, now,
      observations: [{ key: "job:news-refresh", observedAt: now, value: { durationMs: 1500, done: true, secret: "secret-token", events: [
        { event: "news.refreshed", counts: { added: 17, failed: 2 }, detail: "secret-detail" },
      ] } }] });
    const out = html(value);
    expect(out).toContain("수집기별 최근 실행");
    expect(out).toContain("가장 최근 성공 회차");
    expect(out).toContain("전체 실행 이력");
    expect(out).toContain("항목 오류 2");
    expect(out).toContain("추가 17");
    expect(out).toContain("1.5초");
    expect(out).not.toMatch(/secret-token|secret-detail|<pre|작업 실행 요청/);
  });

  it("keeps active, standby, stale and simultaneous lanes visible with known zero queue", () => {
    const value = report();
    value.jobs[0].state = "paused";
    value.jobs[1].state = "retrying";
    value.jobs[2].waiting = 0;
    value.instances = [
      { role: "crawler", instanceId: "m3-crawler", kind: "primary", state: "active", release: "45de7d0", observedAt: now.toISOString(), runtimeStale: false,
        lanes: [{ name: "scan", jobs: ["agent-evidence-refresh"], currentJob: "agent-evidence-refresh", state: "running", startedAt: now.toISOString() },
          { name: "evidence", jobs: ["ai-level-refresh"], currentJob: "ai-level-refresh", state: "running", startedAt: now.toISOString() }] },
      { role: "crawler", instanceId: "mini-crawler-standby", kind: "standby", state: "standby", release: null, observedAt: now.toISOString(), runtimeStale: true,
        lanes: [{ name: "main", jobs: ["crawl-fetch"], currentJob: null, state: "standby", startedAt: null }] },
      { role: "crawler", instanceId: "old-crawler", kind: "primary", state: "stale", release: null, observedAt: now.toISOString(), runtimeStale: true,
        lanes: [{ name: "main", jobs: ["crawl-fetch"], currentJob: null, state: "stale", startedAt: null }] },
    ];
    const out = html(value);
    expect(out).toContain("m3-crawler");
    expect(out).toContain("mini-crawler-standby");
    expect(out).toContain("담당 중");
    expect(out).toContain("예비 대기");
    expect(out).toContain("관측 지연");
    expect(out).toContain("개발 AI 조사 줄");
    expect(out).toContain("AI 단계 줄");
    expect(out).toContain("사람이 중단");
    expect(out).toContain("재시도 대기");
    expect(out).toContain("대기 0");
    expect(out).toContain('role="region"');
    expect(out).toContain('tabindex="0"');
  });

  it("shows failed metrics separately from zero and registers the URL tab", () => {
    const value = report();
    value.roleReadFailed = true;
    value.queueReadFailed = true;
    const out = html(value);
    expect(out).toContain("역할 담당 정보를 읽지 못했습니다");
    expect(out).toContain("대기 집계를 읽지 못했습니다");
    expect(STATUS_TABS).toContain("crawlers");
  });

  it("labels sampled errors and provider failures without inventing failed item totals", () => {
    const value = buildCrawlerActivity({ settings: DEFAULT_CRAWL_SETTINGS, jobs: [], roles: [], throughput: null, now,
      observations: [
        { key: "job:product-stars-refresh", observedAt: now, value: { events: [{ event: "product_stars.refreshed", counts: { failed: true } }] } },
        { key: "job:crawl-seed", observedAt: now, value: { events: [{ event: "crawl.seed_failed", counts: {} }] } },
      ] });
    const out = html(value);
    expect(out).toContain("공급자 오류 · 항목 수 미확인");
    expect(out).toContain("오류 이벤트 1 · 보존분");
    expect(out).toContain("전체 실패 항목 수와 같지 않을 수 있습니다");
    expect(out).not.toContain("항목 오류 1");
  });

  it("labels legacy scan results unknown when persisted failure status was not retained", () => {
    const value = buildCrawlerActivity({ settings: DEFAULT_CRAWL_SETTINGS, jobs: [], roles: [], throughput: null, now,
      observations: [{ key: "job:agent-evidence-refresh", observedAt: now, value: { events: [
        { event: "agent_evidence.scanned", counts: { observations: 0, cached: false } },
      ] } }] });
    const out = html(value);
    expect(out).toContain("수집 결과 미확인");
    expect(out).not.toContain(">회차 성공<");
  });

  it("includes retained request errors in the summary even when aggregate item failures are zero", () => {
    const value = buildCrawlerActivity({ settings: DEFAULT_CRAWL_SETTINGS, jobs: [], roles: [], throughput: null, now,
      observations: [{ key: "job:product-evidence-refresh", observedAt: now, value: { events: [
        { event: "evidence.initial_refresh_queue_failed", counts: {} },
        { event: "evidence.refresh_batch", counts: { attempted: 0, failed: 0 } },
      ] } }] });
    const out = html(value);
    expect(out).toContain("최근 오류 관측 1개");
    expect(out).toContain("오류 이벤트 1 · 보존분");
    expect(out).not.toContain("항목 오류 0");
    expect(out).not.toContain(">회차 성공<");
  });

  it("최근 결과에 마지막 성공 뒤의 실패·미룸을 먼저 적고, 누적 칸에 최근 1시간·24시간 합을 적는다", () => {
    const success = new Date(now.getTime() - 120_000), later = new Date(now.getTime() - 30_000).toISOString();
    const value = buildCrawlerActivity({ settings: { ...DEFAULT_CRAWL_SETTINGS, enabled: true }, roles: [], throughput: null, now,
      jobs: [{ name: "crawl-fetch", lastRunAt: success, lastSuccessAt: success, nextScheduledAt: null, notBefore: null, lockedAt: null,
        leaseToken: null, requestedVersion: 1, processedVersion: 1, lastError: null, runs: 10 }],
      observations: [{ key: "job:crawl-fetch", observedAt: success, value: { done: true, durationMs: 900, events: [
        { event: "crawl.fetched", counts: { fetched: 2, skipped: 0, failed: 0, gated: 0, drained: true } }] } }],
      tallies: [{ job: "crawl-fetch", lastFailedAt: null, hour: { "@ok": 58, "crawl.fetched#fetched": 120, "crawl.fetch_rate_limited": 2 },
        day: { "@ok": 1400, "@failed": 3, "crawl.fetched#fetched": 2400 } }],
      deferrals: [{ job: "crawl-fetch", reason: "model_capacity", lastDeferredAt: later, lastHour: 5, lastHourByReason: { model_capacity: 5 } }] });
    const out = html(value);
    expect(out).toContain("미룸 · 모델 자리(model_capacity)");
    expect(out).toContain("최근 1시간 5회");
    expect(out).toContain("마지막 성공 회차");
    expect(out).toContain("누적 · 최근 1시간 / 24시간");
    expect(out).toContain("최근 1시간 · 회차 58 · 미룸 5");
    expect(out).toContain("원본 수집 결과 원본 확보 120");
    expect(out).toContain("원본 공급자 한도 대기 2회");
    expect(out).toContain("최근 24시간 · 회차 1,400 · 실패 3");
    expect(out).toContain("원본 확보 2,400");
    // 작업 상세 창 조각도 같은 숫자
    const detail = renderToStaticMarkup(createElement(CollectorTotalsDetail, { row: value.jobs.find(row => row.name === "crawl-fetch")!, now: now.toISOString() }));
    expect(detail).toContain("마지막 성공 뒤 미룸 · 모델 자리(model_capacity)");
    expect(detail).toContain("최근 24시간 · 회차 1,400 · 실패 3");
  });

  it("누적을 못 읽었으면 미확인이라 적는다", () => {
    const value = buildCrawlerActivity({ settings: DEFAULT_CRAWL_SETTINGS, jobs: [], observations: [], roles: [], throughput: null, now,
      tallies: null, deferrals: [] });
    const out = html(value);
    expect(out).toContain("회차 누적을 읽지 못했습니다");
    expect(out).toContain("누적 미확인");
  });
});

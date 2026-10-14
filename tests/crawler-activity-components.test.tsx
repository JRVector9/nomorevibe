import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrawlerActivity } from "@/app/(operator)/admin/status/CrawlerActivity";
import { buildCrawlerActivity } from "@/lib/operations/crawler-activity";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { STATUS_TABS } from "@/app/(operator)/admin/status/action-links";

const now = new Date("2026-10-14T03:00:00Z");
const report = () => buildCrawlerActivity({ settings: { ...DEFAULT_CRAWL_SETTINGS, enabled: true }, jobs: [], observations: [],
  roles: [], throughput: null, now });
const html = (value = report()) => renderToStaticMarkup(createElement(CrawlerActivity, { report: value }));

describe("read-only collector activity", () => {
  it("renders every collector with never-run and unknown waiting states, and a manual unscheduled X pilot", () => {
    const out = html();
    expect(out).toContain("수집 대상 탐색");
    expect(out).toContain("Show HN 수집");
    expect(out).toContain("AI 제작 단계 확인");
    expect(out).toContain("README 갱신");
    expect(out).toContain("프로젝트 이미지 수집");
    expect(out).toContain("저장소 사라진 사이트 확인");
    expect(out).toContain("실행 기록 없음");
    expect(out).toContain("대기 미확인");
    expect(out).toContain("자동 수집 안 함");
    expect(out).toContain("수동 API 파일럿");
    expect(out).toContain("용도 승인");
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
});

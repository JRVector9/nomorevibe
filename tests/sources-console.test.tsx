import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { aggregateSources, buildSourcesView, cronJobDefs, funnelOf, jobStatus, LLM_JOBS, SOURCE_JOBS, yieldPercent } from "@/lib/operations/sources-model";
import { SOURCES_FUNNEL, SOURCES_NOW, sourcesFixtureRead } from "./fixtures/sources-console";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/operations/sources-read", () => ({ readSources: mocks.read }));
vi.mock("@/app/(operator)/admin/sources/actions", () => ({ saveJobIntervalAction: vi.fn(), saveFeedSourceAction: vi.fn(), previewFeedSourceAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/status/job-control-actions", () => ({ controlJobAction: vi.fn() }));

import { FeedSourceAddSlot, SourcesSlot } from "@/app/(operator)/admin/sources/slots";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const table = (html: string, label: string) => html.match(new RegExp(`<div class="sc-scroll" role="region" aria-label="${label}"[^]*?</table>`))![0];
const rowOf = (html: string, attr: string, value: string) => html.match(new RegExp(`<tr[^>]*${attr}="${value}"[^>]*>[^]*?</tr>`))![0];
const csrf = { token: "a".repeat(64), expiresAt: 2_000_000_000 };
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue(sourcesFixtureRead()); });

describe("수집원 집계(순수)", () => {
  it("깔때기: 후보 상태 → 거절·사람 확인·승인 대기·공개, 나머지는 아직 심사 전·중", () => {
    expect(funnelOf(SOURCES_FUNNEL.filter(row => row.signal === "Show HN"))).toEqual({ found: 265, rejected: 217, review: 7, approved: 4, published: 35, other: 2 });
    expect(yieldPercent({ found: 19, published: 19 })).toBeNull();
    expect(yieldPercent({ found: 265, published: 35 })).toBeCloseTo(13.2, 1);
  });

  it("신호를 코드의 신호 정의로 묶고(GitHub 검색 = 검색어 라벨들), 정의에 없는 신호는 「그 밖의 신호」 한 줄", () => {
    const read = sourcesFixtureRead();
    const rows = aggregateSources(read.defs, SOURCES_FUNNEL);
    expect(rows.map(row => [row.def.key, row.def.label, row.def.job, row.funnel.found, row.found24])).toEqual([
      ["github", "GitHub 검색", "crawl-seed", 112_792, 13_199], ["show-hn", "Show HN", "hn-show-seed", 265, 50],
      ["feed-show-gn", "Show GN", "gn-show-seed", 2, 2], ["feed-lobste-rs-1a2b3c", "Lobsters Show", "gn-show-seed", 0, 0],
      ["korean", "한국어 프로젝트", "crawl-ko-apply", 0, 0], ["other", "그 밖의 신호", null, 12, 3]]);
    expect(rows[0].signals.map(signal => signal.signal)).toEqual(["Claude 커밋 트레일러", "Codex 커밋 트레일러"]);
    expect(rows[0].yieldPct).toBeCloseTo(7.6, 1);
  });

  it("상태는 읽은 사실만 — 꺼짐 · 사람이 멈춤(누가·언제·사유) · 오류 · 제 일 못 함 · 성공 끊김 · 정상", () => {
    const now = Date.parse(SOURCES_NOW);
    const job = { name: "x", lastRunAt: SOURCES_NOW, lastSuccessAt: SOURCES_NOW, lastError: null, notBefore: null, nextScheduledAt: null, lockedAt: null };
    expect(jobStatus({ job, intervalMs: 60_000, enabled: false, now }).label).toBe("꺼짐");
    expect(jobStatus({ job: { ...job, notBefore: "2126-01-01T00:00:00Z" }, intervalMs: 60_000, now,
      pause: { job: "x", actor: "JR", at: "2026-11-04T01:00:00Z", reason: "점검" } })).toEqual({ tone: "bad", label: "8일째 멈춤", why: "사람이 멈춤 · JR · 11-04 10:00 · 점검" });
    expect(jobStatus({ job: { ...job, lastError: "boom" }, intervalMs: 60_000, now }).label).toBe("오류");
    expect(jobStatus({ job, intervalMs: 60_000, now, degraded: { job: "x", code: "search_failed", detail: "HTTP 503", streak: 3, since: null } }))
      .toEqual({ tone: "warn", label: "제 일 못 함", why: "search_failed · HTTP 503 · 연속 3회" });
    expect(jobStatus({ job: { ...job, lastSuccessAt: new Date(now - 31 * 60_000).toISOString() }, intervalMs: 60_000, now }).label).toBe("성공 끊김");
    expect(jobStatus({ job, intervalMs: 60_000, now })).toEqual({ tone: "ok", label: "정상", why: null });
    expect(jobStatus({ job: null, intervalMs: 60_000, now }).label).toBe("기록 없음");
  });

  it("주기 작업 = 카탈로그 잡 중 LLM 작업·수집원 잡·heartbeat 를 뺀 것, 임베딩(제품 벡터)은 검색 묶음에 남는다", () => {
    const defs = cronJobDefs();
    const names = defs.map(def => def.job);
    for (const task of AI_TASKS.filter(task => task.kind === "chat" || task.kind === "vision")) for (const job of task.jobs) expect(names, job).not.toContain(job);
    for (const job of SOURCE_JOBS) expect(names).not.toContain(job);
    expect(names).not.toContain("heartbeat");
    expect(names).not.toContain("product-intro-check");
    expect(LLM_JOBS.has("product-embedding")).toBe(false);
    expect(defs.find(def => def.job === "product-embedding")).toMatchObject({ group: "search", label: "의미 검색 벡터" });
    expect(defs.find(def => def.job === "crawl-fetch")).toMatchObject({ group: "collect", label: "원본 수집" });
    expect(defs.find(def => def.job === "crawl-judge")).toMatchObject({ group: "collect", label: "규칙 심사" });
    expect(defs.find(def => def.job === "uptime-ping")).toMatchObject({ group: "upkeep" });
    // 빠진 잡 없이 — 모든 카탈로그 잡은 주기 작업이거나 LLM·수집원·heartbeat 다
    for (const job of JOB_CATALOG) expect(names.includes(job.name) || LLM_JOBS.has(job.name) || SOURCE_JOBS.has(job.name) || job.name === "heartbeat", job.name).toBe(true);
  });

  it("화면 모형: 주기는 덮어쓰기를 따르고, 대기는 워커 진행·공개 − 벡터, 검색 묶음에 서버 상태", () => {
    const view = buildSourcesView(sourcesFixtureRead());
    const cron = view.cron.flatMap(group => group.rows);
    expect(cron.find(row => row.job === "crawl-judge")).toMatchObject({ intervalMs: 600_000, defaultMs: 300_000, overridden: true, waiting: 0 });
    expect(cron.find(row => row.job === "product-embedding")).toMatchObject({ waiting: 11, status: { tone: "ok", label: "78,919개 완료" } });
    expect(cron.find(row => row.job === "crawl-fetch")).toMatchObject({ paused: true, version: 31_000, status: { tone: "bad", label: "8일째 멈춤" } });
    expect(view.cron.find(group => group.group === "search")!.servers).toEqual([{ name: "벡터 서버(임베딩)", ok: true, error: null },
      { name: "재정렬 서버", ok: false, error: "연결 실패" }]);
    expect(view.sources.find(row => row.key === "feed-lobste-rs-1a2b3c")).toMatchObject({ intervalMs: 3_600_000, status: { label: "꺼짐" } });
    expect(view.revision).toBe(42);
  });
});

describe("수집·작업 화면(시안 화면 5)", () => {
  it("수집원 표 — 아홉 열, 7일 찾음이 20건 미만이면 자료 부족, 줄은 상세로 잇는다", async () => {
    const html = renderToStaticMarkup(await SourcesSlot({ selected: null, openJob: null, readOnly: false, csrf }));
    const list = table(html, "수집원");
    expect([...list.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map(match => match[1]))
      .toEqual(["수집원", "방식", "주기", "24시간 찾음", "7일 찾음", "7일 공개", "공개까지 간 비율", "마지막 성공", "상태"]);
    expect(text(rowOf(list, "data-source", "github"))).toBe("GitHub 검색 검색 API 1분 13,199 112,792 8,580 7.6% 1분 미만 전 정상");
    expect(text(rowOf(list, "data-source", "show-hn"))).toBe("Show HN 글 목록(API) 30분 50 265 35 13.2% 20분 전 정상");
    expect(text(rowOf(list, "data-source", "feed-show-gn"))).toBe("Show GN 글 목록(RSS) 30분 2 2 1 자료 부족(2건) 20분 전 정상");
    expect(text(rowOf(list, "data-source", "feed-lobste-rs-1a2b3c"))).toContain("Lobsters Show 글 목록(RSS) 1시간 0 0 0 자료 부족 20분 전 꺼짐");
    expect(list).toContain('href="/admin/sources?source=show-hn#source-detail"');
    expect(html).toContain('href="/admin/sources/new"');
    expect(html).not.toContain('id="source-detail"');
  });

  it("수집원 상세 — 깔때기 · 규칙(설정 그대로) · 조치(주기 바꾸기 · 잠시 멈춤)", async () => {
    const html = renderToStaticMarkup(await SourcesSlot({ selected: "show-hn", openJob: null, readOnly: false, csrf }));
    const detail = html.match(/<article id="source-detail"[^]*?<\/article>/)![0];
    expect(text(detail)).toContain("찾음 265 거절 217 사람 확인 7 승인 대기 4 공개 35 아직 심사 전·중 2");
    expect(text(detail)).toContain("켜짐 켬 우선순위 120 AI 흔적 요구하지 않음");
    expect(detail).toContain("주기 바꾸기");
    expect(detail).toContain("잠시 멈춤…");
    const gn = renderToStaticMarkup(await SourcesSlot({ selected: "feed-show-gn", openJob: null, readOnly: false, csrf }));
    expect(text(gn)).toContain("주소 https://news.hada.io/rss/news 고를 글 제목이 「Show GN:」으로 시작 제품 링크 글 페이지의 제목 링크");
    expect(text(gn)).toContain("글 목록 수집원 2개가 함께 멈춥니다");
    const added = renderToStaticMarkup(await SourcesSlot({ selected: "feed-lobste-rs-1a2b3c", openJob: null, readOnly: false, csrf }));
    expect(text(added)).toContain("이 수집원 켜기");
    expect(text(added)).toContain("피드 항목의 링크");
  });

  it("주기 작업 표 — 수집 · 검색 · 공개 뒤 유지, 상태는 읽은 사실(누가·언제·사유), 줄을 열면 주기·멈춤", async () => {
    const html = renderToStaticMarkup(await SourcesSlot({ selected: null, openJob: "crawl-fetch", readOnly: false, csrf }));
    const cron = table(html, "주기 작업");
    expect([...cron.matchAll(/<th scope="rowgroup"[^>]*>([^<]+)<\/th>/g)].map(match => match[1])).toEqual(["수집", "검색", "공개 뒤 유지"]);
    expect(text(rowOf(cron, "data-job", "crawl-fetch"))).toContain("원본 수집 crawl-fetch");
    expect(text(rowOf(cron, "data-job", "crawl-fetch"))).toContain("8일째 멈춤 사람이 멈춤 · JR · 11-04 10:00 · 원본 서버 점검");
    expect(text(rowOf(cron, "data-job", "crawl-judge"))).toContain("10분 바꿈 · 기본 5분");
    expect(text(rowOf(cron, "data-job", "product-evidence-refresh"))).toContain("오류 마지막 회차 오류 · [57014]");
    expect(text(rowOf(cron, "data-job", "hn-talk"))).toContain("제 일 못 함 search_failed · HTTP 503 · 연속 3회");
    expect(text(rowOf(cron, "data-server", "재정렬 서버"))).toContain("연결 실패");
    expect(cron).toContain('data-job-actions="crawl-fetch"');
    expect(text(cron.match(/<tr data-job-actions="crawl-fetch"[^]*?<\/tr>/)![0])).toContain("재개 사유");
    for (const llm of ["crawl-agent-review", "product-intro-check", "crawl-publish", "reason-translate"]) expect(cron).not.toContain(`data-job="${llm}"`);
  });

  it("읽기 전용이면 쓰는 단추가 없다", async () => {
    const html = renderToStaticMarkup(await SourcesSlot({ selected: "show-hn", openJob: "crawl-judge", readOnly: true, csrf: null }));
    expect(html).not.toContain('href="/admin/sources/new"');
    expect(html).not.toContain("주기 바꾸기");
    expect(html).toContain("읽기 전용 화면입니다.");
  });

  it("수집원 추가 — 세 칸이 나란히, 첫 칸은 종류 넷(글 목록만 화면에서, 검색어는 기존 설정으로, 나머지는 개발 필요)", async () => {
    const first = renderToStaticMarkup(await FeedSourceAddSlot({ kind: null, readOnly: false }));
    expect(text(first)).toContain("글 목록(RSS·Atom) 코드 없이 GitHub 검색어 코드 없이 · 수집 설정에서 사이트 목록 개발 필요 그 밖의 API 개발 필요");
    // 시안 화면 4 — 1 종류 · 2 주소와 규칙 · 3 미리 보고 켜기, 지금 칸은 첫 칸
    expect(first.match(/class="cs-k">[^<]+</g)).toEqual(['class="cs-k">1 종류<', 'class="cs-k">2 주소와 규칙<', 'class="cs-k">3 미리 보고 켜기<']);
    expect(first).toMatch(/<li class="cs-step" data-state="now" aria-current="step" aria-label="종류">/);
    expect(first).toContain('href="/admin#signals"');
    const second = renderToStaticMarkup(await FeedSourceAddSlot({ kind: "feed", readOnly: false }));
    expect(text(second)).toContain("제품 링크를 찾는 방법");
    expect(text(second)).toContain("글 목록 작업은 30분마다 돕니다");
    expect(second).toContain("미리 보기");
  });
});

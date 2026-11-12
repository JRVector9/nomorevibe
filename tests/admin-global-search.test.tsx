import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { activityHref, candidateHref, searchTerm, type AdminSearchResult } from "@/lib/operations/admin-search";
import { CommandSearch, searchItems } from "@/app/(operator)/admin/components/CommandSearch";
import { commandJobNames, searchAdminDestinations, searchConsoleCommands } from "@/lib/operations/admin-search-navigation";
import { WORKSPACES } from "@/app/(operator)/admin/workspace-navigation";

/** 관리자 전역 검색(⌘K, 2026-10-08 UX 점검 ADM-05) */
describe("전역 검색 — 찾는 말과 가는 곳", () => {
  it("두 글자부터 찾고 100자까지 자른다", () => {
    expect(searchTerm("a")).toBeNull();
    expect(searchTerm("  ")).toBeNull();
    expect(searchTerm(" lc ")).toBe("lc");
    expect(searchTerm("가")).toBeNull();
    expect(searchTerm("가계")).toBe("가계");
    expect(searchTerm("x".repeat(150))).toHaveLength(100);
  });

  it("후보는 그 저장소로 거르고 그 줄을 고른 심사 큐로 — 거부·발행은 그 보기로", () => {
    expect(candidateHref({ id: 7, repo: "acme/tool", state: "needs_review" })).toBe("/admin/review?q=acme%2Ftool&focus=7#review-list");
    expect(candidateHref({ id: 8, repo: "acme/x", state: "rejected" })).toBe("/admin/review?state=rejected&q=acme%2Fx&focus=8#review-list");
    expect(candidateHref({ id: 9, repo: "acme/y", state: "published" })).toBe("/admin/review?state=published&q=acme%2Fy&focus=9#review-list");
    expect(activityHref("acme/tool")).toBe("/admin/activity?target=acme%2Ftool");
  });

  it("결과를 제품·후보·작업 로그 대상 차례의 한 목록으로, 빈 묶음은 뺀다", () => {
    const result: AdminSearchResult = {
      q: "lcu",
      products: [{ slug: "lcu", name: "LCU", url: "https://lcu.example", repoUrl: "https://github.com/amontlabs/lcu", status: "banned",
        href: "/admin/products/lcu", publicHref: "/p/lcu", logHref: "/admin/activity?target=lcu" }],
      candidates: [],
      engines: [], models: [], destinations: [],
      targets: [{ target: "lcu", count: 3, lastAt: new Date("2026-10-11T00:00:00Z"), href: "/admin/activity?target=lcu" }],
    };
    const sections = searchItems(result);
    expect(sections.map((section) => section.group)).toEqual(["프로젝트", "작업 로그 대상"]);
    expect(sections[0].items[0]).toMatchObject({ title: "LCU", detail: "amontlabs/lcu", badge: "차단됨", href: "/admin/products/lcu" });
    expect(sections[0].items[0].extra?.map((link) => link.label)).toEqual(["공개 페이지", "기록"]);
    expect(sections[1].items[0]).toMatchObject({ title: "lcu", detail: "3건" });
    expect(searchItems(null)).toEqual([]);
  });

  it("엔진·모델·작업을 프로젝트 앞에서 분류하고 모델의 연결과 고칠 칸으로 보낸다", () => {
    const href = "/admin/models/llm?edit=conn#conn-conn";
    const contextHref = "/admin/models/llm?edit=conn&fix=context#conn-conn-context";
    const sections = searchItems({ q: "m1", products: [], candidates: [], targets: [],
      engines: [{ id: "conn", label: "M1 Max", kind: "api", deviceId: "m1max", baseUrl: "https://m1.test/v1", enabled: true,
        contextTokens: 32768, href, contextHref }],
      models: [{ connectionId: "conn", connectionLabel: "M1 Max", deviceId: "m1max", kind: "api", model: "gemma", enabled: true, href }],
      destinations: [{ id: "context", title: "컨텍스트 상한", detail: "연결 편집", href: "/admin/models/llm" }] });
    expect(sections.map(section => section.group)).toEqual(["엔진·연결", "모델", "작업·설정"]);
    expect(sections[0].items[0].extra).toEqual([{ label: "컨텍스트 상한", href: contextHref }]);
    expect(sections[1].items[0]).toMatchObject({ title: "gemma", detail: "M1 Max · m1max", href });
    expect(searchAdminDestinations("crawl-agent-review")).toContainEqual(expect.objectContaining({ href: "/admin/models/tasks#execution-first-review-1" }));
    expect(searchAdminDestinations("컨텍스트상한")[0]).toMatchObject({ id: "context", href: "/admin/models/llm" });
  });

  it("배포 중 이전 서버의 세 묶음 응답을 받아도 검색 창이 깨지지 않는다", () => {
    expect(searchItems({ q: "old", products: [], candidates: [], targets: [] } as unknown as AdminSearchResult)).toEqual([]);
  });

  it("사이드바 단추와 검색 창(콤보박스·목록)을 그린다 — 창은 닫혀 있다", () => {
    const html = renderToStaticMarkup(createElement(CommandSearch));
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(html).toContain(">찾기</span>");
    expect(html).toMatch(/<dialog[^>]*aria-label="관리자 전역 검색"/);
    expect(html).not.toMatch(/<dialog[^>]* open/);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("2글자 이상 입력하면 찾습니다");
  });
});

/** ⌘K 찾기·바꾸기(운영 콘솔 개편 조각 4b, 시안 흐름 7) — 이름을 치면 화면 · 조치 · 기록이 함께 */
describe("찾기·바꾸기 — 이름 하나로 화면, 조치, 기록", () => {
  const supa = { id: "conn-supa", label: "supa", enabled: true, deviceId: "supa", stages: 3 };

  it("모델 이름이면 시안 그대로 열기 · 쓰는 단계 · 쉬게 하기 · 기록을 낸다 — 조치는 실행하지 않고 그 자리로 보낸다", () => {
    expect(searchConsoleCommands("supa", { models: [supa], jobs: [] }).map(row => [row.kind, row.title, row.href])).toEqual([
      ["open", "모델 supa 열기", "/admin/models?model=conn-supa"],
      ["open", "supa를 쓰는 단계 3개", "/admin/models?model=conn-supa#model-stages"],
      ["action", "supa 쉬게 하기", "/admin/models?model=conn-supa#model-actions"],
      ["log", "supa가 나온 기록", "/admin/log?q=supa"],
    ]);
    // 쉬는 모델은 다시 켜기, 쓰는 단계가 없으면 그 줄은 없다
    expect(searchConsoleCommands("m1", { models: [{ ...supa, id: "conn-m1", label: "M1max", enabled: false, stages: 0 }], jobs: [] }).map(row => row.title))
      .toEqual(["모델 M1max 열기", "M1max 다시 켜기", "M1max가 나온 기록"]);
  });

  it("단계 이름이면 패널 열기, 멈춘 작업은 재개(그 패널의 작업 칸 — 사유 필수), 모델 바꾸기, 기록", () => {
    const rows = searchConsoleCommands("소개 검수", { models: [], jobs: [{ name: "product-intro-check", paused: true }] });
    expect(rows.map(row => [row.kind, row.title, row.href])).toEqual([
      ["open", "소개 검수 단계 열기", "/admin/flow?stage=intro-check"],
      ["action", "소개 검수 재개", "/admin/flow?stage=intro-check#sp-jobs"],
      ["action", "소개 검수 모델 바꾸기", "/admin/flow?stage=intro-check#sp-models"],
      ["log", "소개 검수가 나온 기록", "/admin/log?q=%EC%86%8C%EA%B0%9C%20%EA%B2%80%EC%88%98"],
    ]);
    expect(rows[1].detail).toContain("사유");
    // 돌고 있으면 잠시 멈춤, 상태를 못 읽었으면 둘 다 적는다
    expect(searchConsoleCommands("소개 검수", { models: [], jobs: [{ name: "product-intro-check", paused: false }] })[1].title).toBe("소개 검수 잠시 멈춤");
    expect(searchConsoleCommands("소개 검수", { models: [], jobs: null })[1].title).toBe("소개 검수 멈춤·재개");
  });

  it("수집원과 단계 밖의 잡, 모델 접수도 찾는다", () => {
    expect(searchConsoleCommands("show hn", { models: [], jobs: [{ name: "hn-show-seed", paused: false }] }).map(row => [row.kind, row.title, row.href])).toEqual([
      ["open", "수집원 Show HN 보기", "/admin/flow?stage=discover"],
      ["action", "Show HN 수집 잠시 멈춤", "/admin/flow?stage=discover#sp-jobs"],
      ["log", "Show HN이 나온 기록", "/admin/log?q=hn-show-seed"],
    ]);
    expect(searchConsoleCommands("audit-qwen", { models: [], jobs: [] }).map(row => [row.kind, row.href])).toEqual([
      ["open", "/admin/status?tab=jobs&job=audit-qwen"], ["action", "/admin/status?tab=jobs&job=audit-qwen"], ["log", "/admin/log?q=audit-qwen"]]);
    expect(searchConsoleCommands("접수", { models: [], jobs: [] })).toContainEqual(expect.objectContaining({ kind: "action", title: "모델 접수 멈추기·열기",
      href: "/admin/models/dashboard#admission" }));
    expect(searchConsoleCommands("a", { models: [supa], jobs: [] })).toEqual([]);
  });

  it("잡 상태는 그 말이 단계·잡 이름에 걸릴 때만 읽는다", () => {
    expect(commandJobNames("소개 검수")).toEqual(["product-intro-check"]);
    expect(commandJobNames("show hn")).toEqual(["hn-show-seed"]);
    expect(commandJobNames("supa")).toEqual([]);
  });

  it("화면 바로 가기의 제목은 메뉴 여섯의 이름으로 시작한다 — 옛 메뉴 이름(「설정·기록」)은 찾는 말에만 남는다", () => {
    const menus = WORKSPACES.map(page => page.label);
    const pages = ["홈", "알림", "사람", "모델", "작업", "수집", "콘텐츠", "기록", "설정·기록", "LLM", "고급", "한도"].flatMap(term => searchAdminDestinations(term))
      .filter(row => !row.id.startsWith("task:") && row.id !== "context");
    expect(pages.length).toBeGreaterThan(10);
    for (const row of pages) expect(menus, row.title).toContain(row.title.split(" › ")[0]);
    expect(pages.some(row => row.title.includes("설정·기록"))).toBe(false);
    expect(searchAdminDestinations("설정·기록").map(row => row.title)).toEqual(expect.arrayContaining(["수집·작업 › 수집·판정", "기록 › 바꾼 것"]));
  });

  it("검색 창은 찾기·바꾸기 갈래를 맨 앞에 두고 화면 · 조치 · 기록 표를 단다", () => {
    const sections = searchItems({ q: "supa", products: [], candidates: [], targets: [], engines: [], models: [], destinations: [],
      commands: searchConsoleCommands("supa", { models: [supa], jobs: [] }) });
    expect(sections.map(section => section.group)).toEqual(["바로 가기 · 조치 · 기록"]);
    expect(sections[0].items.map(item => [item.title, item.badge])).toEqual([["모델 supa 열기", "화면"], ["supa를 쓰는 단계 3개", "화면"],
      ["supa 쉬게 하기", "조치"], ["supa가 나온 기록", "기록"]]);
    const html = renderToStaticMarkup(<CommandSearch appearance="prototype" />);
    expect(html).toContain(">찾기 · 바꾸기</span>");
  });
});

describe("전역 검색 경로", () => {
  beforeEach(() => vi.clearAllMocks());
  it("관리자가 아니면 403 이고 검색하지 않는다", async () => {
    mocks.admin.mockResolvedValue(null);
    const { GET } = await import("@/app/(operator)/admin/search/route");
    const response = await GET(new Request("https://admin.test/admin/search?q=lcu"), {} as never);
    expect(response.status).toBe(403);
  });
});

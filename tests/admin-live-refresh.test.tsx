import { readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), pathname: "/admin/review", search: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: router.refresh }), usePathname: () => router.pathname,
  useSearchParams: () => new URLSearchParams(router.search) }));

import { BUSY_LIMIT_MS, clockLabel, createNavigationGuard, createRefreshScheduler, freshCookie, hasPagedRows, hasUnsaved, isTextEntry, LIVE_STORAGE_KEY, mergeBadges, pauseReason,
  readLivePreference, refreshPolicy, UNSAVED_SELECTOR, writeLivePreference } from "@/app/(operator)/admin/live-refresh";
import { LiveBar } from "@/app/(operator)/admin/components/LiveBar";
import { AdminShell } from "@/app/(operator)/admin/AdminShell";

describe("화면마다 다시 읽는 규칙", () => {
  it("운영센터 10초, 심사·오늘 할 일 30초, 설정 60초, 일반 목록 15초를 유지한다", () => {
    expect(refreshPolicy("/admin/status")).toEqual({ intervalMs: 10_000, idleMs: 0 });
    expect(refreshPolicy("/admin/review")).toEqual({ intervalMs: 30_000, idleMs: 60_000 });
    expect(refreshPolicy("/admin/review/products")).toEqual({ intervalMs: 30_000, idleMs: 60_000 });
    expect(refreshPolicy("/admin")).toEqual({ intervalMs: 60_000, idleMs: 15_000 });
    // 오늘 할 일은 칸 열네 개를 주 DB 에서 센다 — 자주 읽지 않는다
    expect(refreshPolicy("/admin/inbox")).toEqual({ intervalMs: 30_000, idleMs: 60_000 });
    expect(refreshPolicy("/admin/audit")).toEqual({ intervalMs: 15_000, idleMs: 15_000 });
    // 이름이 같은 앞부분만으로 운영센터로 보지 않는다
    expect(refreshPolicy("/admin/statusx").intervalMs).toBe(15_000);
  });

  it.each([
    ['/admin/flow', '', 15_000, 0], ['/admin/flow', 'tab=diagnostics', 15_000, 0],
    ['/admin/flow', 'tab=changes', 60_000, 15_000], ['/admin/models', '', 15_000, 15_000],
    ['/admin/models', 'tab=live', 15_000, 15_000], ['/admin/models', 'tab=capacity', 15_000, 15_000],
    ['/admin/models', 'tab=unknown', 15_000, 15_000], ['/admin/models', 'tab=history', 60_000, 15_000],
    ['/admin/models', 'tab=tasks', 60_000, 15_000], ['/admin/models', 'tab=connections', 60_000, 15_000],
    ['/admin/review', 'tab=rejected', 60_000, 60_000], ['/admin/review', 'tab=human', 30_000, 60_000],
    ['/admin/requests', 'tab=history', 60_000, 15_000], ['/admin/requests', 'tab=open', 15_000, 15_000],
    ['/admin/settings', 'tab=collection', 60_000, 15_000], ['/admin/settings', 'tab=history', 60_000, 15_000],
    ['/admin/content', 'tab=ranking', 60_000, 15_000], ['/admin/activity', '', 60_000, 15_000],
  ])('%s?%s uses its current purpose', (pathname, query, intervalMs, idleMs) => {
    expect(refreshPolicy(pathname, new URLSearchParams(query))).toEqual({ intervalMs, idleMs });
  });

  it("가려진 창 → 저장하지 않은 변경 → 입력 중 → 방금 조작 차례로 멈추고, 아니면 읽는다", () => {
    const base = { visible: true, editing: false, unsaved: false, idleForMs: 60_000, idleMs: 15_000 };
    expect(pauseReason(base)).toBeNull();
    expect(pauseReason({ ...base, visible: false, unsaved: true })).toBe("hidden");
    expect(pauseReason({ ...base, unsaved: true, editing: true })).toBe("unsaved");
    expect(pauseReason({ ...base, editing: true })).toBe("editing");
    expect(pauseReason({ ...base, idleForMs: 3_000 })).toBe("active");
    // 운영센터(idleMs 0)는 조작 중에도 읽는다
    expect(pauseReason({ ...base, idleForMs: 0, idleMs: 0 })).toBeNull();
  });

  it("글자를 넣는 칸만 입력 중으로 본다 — 고르기 상자·체크·단추는 아니다", () => {
    const element = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as Element;
    expect(isTextEntry(element("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntry(element("INPUT", { type: "search" }))).toBe(true);
    expect(isTextEntry(element("INPUT", { type: "" }))).toBe(true);
    expect(isTextEntry(element("TEXTAREA"))).toBe(true);
    expect(isTextEntry(element("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextEntry(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextEntry(element("SELECT"))).toBe(false);
    expect(isTextEntry(element("BUTTON"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it("켜짐·꺼짐을 저장소에 기억하고, 저장소가 막혀 있으면 켜짐으로 시작한다", () => {
    const store = new Map<string, string>();
    const storage = () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    expect(readLivePreference(storage)).toBe(true);
    writeLivePreference(storage, false);
    expect(store.get(LIVE_STORAGE_KEY)).toBe("off");
    expect(readLivePreference(storage)).toBe(false);
    writeLivePreference(storage, true);
    expect(readLivePreference(storage)).toBe(true);
    const blocked = () => { throw new Error("SecurityError"); };
    expect(readLivePreference(blocked)).toBe(true);
    expect(() => writeLivePreference(blocked, false)).not.toThrow();
    expect(readLivePreference(() => null)).toBe(true);
  });

  it("새로고침 쿠키는 관리자 화면 모두에서 5초, 시각은 한국 시:분:초", () => {
    expect(freshCookie()).toBe("ops_fresh=1; Max-Age=5; Path=/admin; SameSite=Strict");
    expect(clockLabel("2026-10-21T04:38:20.000Z")).toBe("13:38:20");
    expect(clockLabel(null)).toBe("—");
    expect(BUSY_LIMIT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("저장하지 않은 변경([data-dirty])과 열린 확인 창이 있으면 멈춘다", () => {
    const root = (found: string | null) => ({ querySelector: (selector: string) => { expect(selector).toBe(UNSAVED_SELECTOR); return found; } });
    expect(UNSAVED_SELECTOR).toContain("[data-dirty]");
    // RankDrawer (.fr) and other native modal dialogs need the same protection as ConfirmAction.
    expect(UNSAVED_SELECTOR).toContain("dialog[open]");
    expect(hasUnsaved(root("dialog") as never)).toBe(true);
    expect(hasUnsaved(root(null) as never)).toBe(false);
    expect(hasUnsaved(null)).toBe(false);
  });
});

describe("자동 갱신의 차례(createRefreshScheduler)", () => {
  const calm = { visible: true, editing: false, unsaved: false, idleMs: 15_000 };
  it("추가로 읽은 목록은 자동 갱신으로 초기화하지 않고 수동 갱신을 허용한다", () => {
    const scheduler = createRefreshScheduler(() => 60_000);
    expect(hasPagedRows({ querySelector: (selector: string) => selector === '[data-admin-scroll-active="true"]' ? {} : null } as never)).toBe(true);
    expect(hasPagedRows(null)).toBe(false);
    expect(scheduler.tick({ ...calm, paging: true })).toEqual({ refresh: false, paused: "paging" });
    expect(scheduler.now()).toBe(true);
    scheduler.settled();
    expect(scheduler.tick(calm)).toEqual({ refresh: true, paused: null });
  });
  it("열린 확인 창·고친 값이 있으면 읽지 않고 까닭을 돌려준다, 닫히면 다시 읽는다", () => {
    let clock = 1_000_000;
    const scheduler = createRefreshScheduler(() => clock);
    expect(scheduler.tick({ ...calm, unsaved: true })).toEqual({ refresh: false, paused: "unsaved" });
    expect(scheduler.tick(calm)).toEqual({ refresh: true, paused: null });
    scheduler.settled();
    scheduler.input();
    clock += 5_000;
    expect(scheduler.tick(calm)).toEqual({ refresh: false, paused: "active" });
    clock += 15_000;
    expect(scheduler.tick(calm)).toEqual({ refresh: true, paused: null });
  });

  it("다시 읽는 중에는 겹치지 않고, 1분 넘게 막히면 한 번만 다시 부른 뒤 끝날 때까지 쉰다", () => {
    let clock = 0;
    const scheduler = createRefreshScheduler(() => clock);
    expect(scheduler.tick(calm).refresh).toBe(true);
    clock += 10_000;
    expect(scheduler.tick(calm)).toEqual({ refresh: false, paused: null });
    clock += BUSY_LIMIT_MS;
    expect(scheduler.tick(calm)).toEqual({ refresh: true, paused: null });
    clock += BUSY_LIMIT_MS * 3;
    expect(scheduler.tick(calm)).toEqual({ refresh: false, paused: "stuck" });
    scheduler.settled();
    expect(scheduler.tick(calm).refresh).toBe(true);
  });

  it("수동 새로고침이 도는 동안 자동 갱신은 부르지 않고, 진행 중 즉시 읽기도 겹치지 않는다", () => {
    let clock = 0;
    const scheduler = createRefreshScheduler(() => clock);
    expect(scheduler.tick({ ...calm, manualBusy: true })).toEqual({ refresh: false, paused: null });
    expect(scheduler.tick(calm).refresh).toBe(true);
    clock += 1_000;
    // 자동 갱신이 도는 중이어도 뒤로 가기 같은 즉시 읽기는 막힌 것이 아니면 겹치지 않는다
    expect(scheduler.now()).toBe(false);
    scheduler.settled();
    expect(scheduler.now()).toBe(true);
  });

  it("탐색·loading 중에는 오래 걸린 자동 갱신 재시도도 새로 시작하지 않는다", () => {
    let clock = 0;
    const scheduler = createRefreshScheduler(() => clock);
    expect(scheduler.tick({ ...calm, navigationBusy: true })).toEqual({ refresh: false, paused: "navigation" });
    expect(scheduler.tick(calm).refresh).toBe(true);
    clock += BUSY_LIMIT_MS * 2;
    expect(scheduler.tick({ ...calm, navigationBusy: true })).toEqual({ refresh: false, paused: "navigation" });
    scheduler.settled();
    expect(scheduler.tick(calm).refresh).toBe(true);
  });

  it("LiveBar 는 갱신 중 포커스를 잃지 않도록 aria-disabled로 표시한다", () => {
    const source = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/components/LiveBar.tsx"), "utf8");
    expect(source).toMatch(/const \[autoPending, startAuto\] = useTransition\(\)/);
    expect(source).toMatch(/const \[manualPending, startManual\] = useTransition\(\)/);
    expect(source).toContain('aria-disabled={manualPending || autoPending || pausedReason === "navigation" || undefined}');
    expect(source).not.toMatch(/admin-live-refresh"[^>]*\sdisabled=/);
    expect(source).toContain('addEventListener("popstate"');
    expect(source).toContain('addEventListener("wheel"');
  });
});

describe("탐색 중 갱신 차단", () => {
  it("목적지와 다른 redirect/interrupt commit도 차단을 해제한다", () => {
    const guard = createNavigationGuard();
    guard.begin('/admin/flow?', '/admin/models?');
    expect(guard.pending()).toBe(true);
    guard.committed('/admin/flow?');
    expect(guard.pending()).toBe(true);
    guard.committed('/admin/login?');
    expect(guard.pending()).toBe(false);
  });

  it("URL이 바뀌지 않은 실패는 기한 후 풀고 같은 주소 클릭은 새 탐색으로 세지 않는다", () => {
    let clock = 0;
    const guard = createNavigationGuard(() => clock);
    guard.begin('/admin/flow?', '/admin/flow?');
    expect(guard.pending()).toBe(false);
    guard.begin('/admin/flow?', '/admin/models?');
    clock += BUSY_LIMIT_MS - 1;
    expect(guard.pending()).toBe(true);
    clock++;
    expect(guard.pending()).toBe(false);
  });
});

describe("메뉴 배지 합치기", () => {
  it("셀 수 없었던 칸은 전에 보이던 값을 두고, 나머지는 새 값(없으면 배지 없음)", () => {
    const before = { "/admin/review": { label: "3" }, "/admin/status": { label: "2" }, "/admin/audit": { label: "요청 1" } };
    expect(mergeBadges(before, { badges: { "/admin/status": { label: "5" } }, unknown: ["/admin/review"] }))
      .toEqual({ "/admin/review": { label: "3" }, "/admin/status": { label: "5" } });
    expect(mergeBadges(undefined, { badges: {}, unknown: ["/admin/review"] })).toEqual({});
  });
});

describe("마지막 갱신 = 화면을 그린 시각", () => {
  it("관리자 화면마다 PageStamp 를 둔다(로그인 제외)", () => {
    const root = path.resolve(__dirname, "..");
    const pages = execSync('find "app/(operator)/admin" -name page.tsx', { cwd: root }).toString().trim().split("\n")
      .filter((file) => !file.includes("/login/"));
    expect(pages.length).toBeGreaterThan(15);
    const verifyStamp = (file: string, parents = new Set<string>()) => {
      expect(parents.has(file), `cyclic page delegation: ${file}`).toBe(false);
      const source = readFileSync(file, "utf8");
      if (source.includes("<PageStamp />")) return;
      // Workspace entrypoints render the original stamped server pages. Check every delegate instead of mounting a second stamp.
      const delegates = [...source.matchAll(/import (\w+) from "(\.\.[^"]*\/page)";/g)];
      expect(delegates.length, `missing PageStamp or page delegation: ${file}`).toBeGreaterThan(0);
      for (const [, name, relative] of delegates) {
        expect(source, `unused page delegate: ${file}`).toContain(`<${name}`);
        verifyStamp(path.resolve(path.dirname(file), relative + ".tsx"), new Set([...parents, file]));
      }
    };
    for (const file of pages) verifyStamp(path.join(root, file));
  });
});

describe("갱신 줄", () => {
  it("켜짐·꺼짐을 글자로 보이는 스위치, 따로 새로고침, 마지막 갱신 시각을 그린다", () => {
    router.pathname = "/admin/review";
    const html = renderToStaticMarkup(createElement(LiveBar, { fallbackAt: "2026-10-21T04:38:20.000Z" }));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    // 스위치 이름은 늘 "자동 갱신" — 보이는 글자(켜짐·초)는 이름에 섞이지 않는다
    expect(html).toContain('aria-label="자동 갱신"');
    expect(html).toContain('<span aria-hidden="true"><span class="admin-status"');
    // 심사 큐의 쉬는 조건(손 뗀 지 1분)을 스위치 설명에 적는다
    expect(html).toContain("1분 동안은 쉽니다");
    expect(html).toContain("자동 갱신 켜짐 · 30초");
    expect(html).toContain("30초마다 다시 읽음");
    expect(html).toContain(">새로고침</button>");
    expect(html).toContain('마지막 갱신 <time dateTime="2026-10-21T04:38:20.000Z">13:38:20</time>');
  });

  it("관리자 틀이 모든 화면 머리에 갱신 줄을 두고, 로그인 화면에는 두지 않는다", () => {
    router.pathname = "/admin/inbox";
    const shell = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z" badges={{}}><main>PAGE-BODY</main></AdminShell>);
    expect(shell).toContain("prototype-live");
    expect(shell).toContain("30초 자동 관측");
    expect(shell.indexOf("prototype-live")).toBeLessThan(shell.indexOf("PAGE-BODY"));
    router.pathname = "/admin/login";
    const login = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z"><main>로그인</main></AdminShell>);
    expect(login).not.toContain("prototype-live");
  });

  it("같은 기존 URL도 query에 따라 작업 공간을 고르고 계정과 검색을 유지한다", () => {
    router.pathname = "/admin/audit";
    router.search = "tab=requests";
    const requests = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z" account="operator@example.com"><main>실제 화면 본문</main></AdminShell>);
    expect(requests).toContain('data-workspace="requests"');
    expect(requests).toContain('admin-workspace-tabs');
    expect(requests).toContain('search-launch');
    expect(requests).toContain('operator@example.com');
    expect(requests).toContain('action="/api/auth/logout"');
    router.search = "tab=policy";
    const quality = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z"><main>실제 화면 본문</main></AdminShell>);
    expect(quality).toContain('data-workspace="projects"');
    expect(quality).toContain('실제 화면 본문');
    router.search = "";
  });
});

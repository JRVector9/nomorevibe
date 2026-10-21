import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), pathname: "/admin/review" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: router.refresh }), usePathname: () => router.pathname }));

import { BUSY_LIMIT_MS, clockLabel, freshCookie, isTextEntry, laterOf, LIVE_STORAGE_KEY, pauseReason, readLivePreference, refreshPolicy,
  writeLivePreference } from "@/app/(operator)/admin/live-refresh";
import { LiveBar } from "@/app/(operator)/admin/components/LiveBar";
import { AdminShell } from "@/app/(operator)/admin/AdminShell";

describe("화면마다 다시 읽는 규칙", () => {
  it("운영센터는 10초·조작 중에도, 심사 큐는 30초·손 뗀 지 1분, 크롤 설정은 30초, 나머지는 15초", () => {
    expect(refreshPolicy("/admin/status")).toEqual({ intervalMs: 10_000, idleMs: 0 });
    expect(refreshPolicy("/admin/review")).toEqual({ intervalMs: 30_000, idleMs: 60_000 });
    expect(refreshPolicy("/admin/review/products")).toEqual({ intervalMs: 30_000, idleMs: 60_000 });
    expect(refreshPolicy("/admin")).toEqual({ intervalMs: 30_000, idleMs: 15_000 });
    expect(refreshPolicy("/admin/inbox")).toEqual({ intervalMs: 15_000, idleMs: 15_000 });
    expect(refreshPolicy("/admin/audit")).toEqual({ intervalMs: 15_000, idleMs: 15_000 });
    // 이름이 같은 앞부분만으로 운영센터로 보지 않는다
    expect(refreshPolicy("/admin/statusx").intervalMs).toBe(15_000);
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

  it("새로고침 쿠키는 관리자 화면 모두에서 5초, 시각은 한국 시:분:초, 늦은 시각을 고른다", () => {
    expect(freshCookie()).toBe("ops_fresh=1; Max-Age=5; Path=/admin; SameSite=Strict");
    expect(clockLabel("2026-10-21T04:38:20.000Z")).toBe("13:38:20");
    expect(clockLabel(null)).toBe("—");
    expect(laterOf("2026-10-21T04:00:00.000Z", "2026-10-21T04:00:05.000Z")).toBe("2026-10-21T04:00:05.000Z");
    expect(laterOf("2026-10-21T04:00:05.000Z", "2026-10-21T04:00:00.000Z")).toBe("2026-10-21T04:00:05.000Z");
    expect(laterOf("2026-10-21T04:00:05.000Z", null)).toBe("2026-10-21T04:00:05.000Z");
    expect(BUSY_LIMIT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("갱신 줄", () => {
  it("켜짐·꺼짐을 글자로 보이는 스위치, 따로 새로고침, 마지막 갱신 시각을 그린다", () => {
    router.pathname = "/admin/review";
    const html = renderToStaticMarkup(createElement(LiveBar, { shownAt: "2026-10-21T04:38:20.000Z" }));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("자동 갱신 켜짐 · 30초");
    expect(html).toContain("30초마다 다시 읽음");
    expect(html).toContain(">새로고침</button>");
    expect(html).toContain('마지막 갱신 <time dateTime="2026-10-21T04:38:20.000Z">13:38:20</time>');
  });

  it("관리자 틀이 모든 화면 머리에 갱신 줄을 두고, 로그인 화면에는 두지 않는다", () => {
    router.pathname = "/admin/inbox";
    const shell = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z" badges={{}}><main>PAGE-BODY</main></AdminShell>);
    expect(shell).toContain("admin-live-bar");
    expect(shell).toContain("자동 갱신 켜짐 · 15초");
    expect(shell.indexOf("admin-live-bar")).toBeLessThan(shell.indexOf("PAGE-BODY"));
    router.pathname = "/admin/login";
    const login = renderToStaticMarkup(<AdminShell renderedAt="2026-10-21T04:38:20.000Z"><main>로그인</main></AdminShell>);
    expect(login).not.toContain("admin-live-bar");
  });
});

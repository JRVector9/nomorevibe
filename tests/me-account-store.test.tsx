import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { common } from "@/messages/ko/common";

/**
 * 화면 하나가 나눠 쓰는 로그인 상태(components/me/account-store.ts) — 묻지 못한 답을 굳히지 않고, 로그인이 꺼진 화면은 묻지 않으며,
 * 요약이 채운 안 읽은 수는 다시 묻지 않는다. 아래 탭 '마이' 점은 화면 낭독기에도 수를 말한다.
 */
const mocks = vi.hoisted(() => ({ unread: 0, markAuthDisabled: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/me/account-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/me/account-store")>(),
  useUnreadCount: () => mocks.unread,
  markAuthDisabled: mocks.markAuthDisabled,
}));

type Store = typeof import("@/components/me/account-store");
async function freshStore(): Promise<Store> {
  vi.resetModules();
  return vi.importActual<Store>("@/components/me/account-store");
}

const account = { user: { id: 7, displayName: "하늘", createdAt: "2026-10-01T00:00:00.000Z" }, isMaker: false, providers: [],
  counts: { saved: 1, tried: 0, opinions: 0, following: 0, unreadAlerts: 3 }, csrfToken: "csrf" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("로그인 상태 나눠 쓰기", () => {
  it("묻지 못한 답(503·끊김)은 기억하지 않는다 — 다음 물음이 다시 묻는다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ error: "unavailable" }, 503))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json(account));
    vi.stubGlobal("fetch", fetcher);
    expect(await store.loadMeState()).toEqual({ status: "error", account: null });
    expect(await store.loadMeState()).toEqual({ status: "error", account: null });
    expect(await store.loadMeState()).toMatchObject({ status: "ok", account: { user: { id: 7 } } });
    expect(await store.loadMeAccount()).toMatchObject({ csrfToken: "csrf" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("로그인 기능이 꺼진 화면은 요약을 묻지 않는다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    store.markAuthDisabled();
    expect(await store.loadMeState()).toEqual({ status: "off", account: null });
    await store.refreshUnreadCount();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("이미 받은 답은 꺼짐 표시로 덮지 않는다", async () => {
    const store = await freshStore();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(account)));
    await store.loadMeState();
    store.markAuthDisabled();
    expect(await store.loadMeState()).toMatchObject({ status: "ok" });
  });

  it("닉네임을 바꾸면 다시 묻지 않고 같은 계정 값에 반영한다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn().mockResolvedValue(json(account));
    vi.stubGlobal("fetch", fetcher);
    await store.loadMeState();
    store.patchMeAccount({ user: { displayName: "바다" } });
    expect(await store.loadMeAccount()).toMatchObject({ user: { id: 7, displayName: "바다" }, csrfToken: "csrf" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("안 읽은 수", () => {
  it("요약이 방금 채운 수는 다시 묻지 않고, 1분이 지나면 묻는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await freshStore();
    const fetcher = vi.fn(async (url: string) => url.endsWith("/unread") ? json({ unread: 5 }) : json(account));
    vi.stubGlobal("fetch", fetcher);
    await store.refreshUnreadCount();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/me/summary"]);
    vi.setSystemTime(Date.now() + 61_000);
    await store.refreshUnreadCount();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/me/summary", "/api/me/notifications/unread"]);
  });
});

describe("아래 탭 '마이' 점", () => {
  const render = (props: { authEnabled?: boolean }) => renderToStaticMarkup(
    <I18nProvider locale="ko" dictionaries={{ common }}>{createElement(MobileNavRef.current!, props)}</I18nProvider>);
  const MobileNavRef: { current: null | typeof import("@/components/home/MobileNav").MobileNav } = { current: null };

  it("안 읽은 수를 화면 낭독기에 이름 뒤로 말하고, 없으면 말하지 않는다", async () => {
    MobileNavRef.current = (await import("@/components/home/MobileNav")).MobileNav;
    mocks.unread = 3;
    const html = render({ authEnabled: true });
    expect(html).toContain('<span class="dot" data-me-dot="true"></span></span>마이<span class="sr-only">, 안 읽은 알림 3개</span>');
    mocks.unread = 0;
    expect(render({ authEnabled: true })).not.toContain("sr-only");
  });

  it("로그인 기능이 꺼져 있으면 요약을 묻지 않게 알린다", async () => {
    MobileNavRef.current = (await import("@/components/home/MobileNav")).MobileNav;
    mocks.markAuthDisabled.mockClear();
    render({ authEnabled: true });
    expect(mocks.markAuthDisabled).not.toHaveBeenCalled();
    render({});
    expect(mocks.markAuthDisabled).toHaveBeenCalled();
  });
});

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

const ME = "/api/me?view=header";
const account = { user: { id: 7, displayName: "하늘" }, isMaker: false, providers: [], unreadAlerts: 3, savedVersion: "1:100", csrfToken: "csrf" };
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

  it("로그인 꺼짐은 JSON 404 public_auth_disabled 만 — 다른 404(배포 중 옛 서버의 HTML 404)는 묻지 못한 것으로 두고 다시 묻는다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html><title>404</title>", { status: 404, headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(json(account))
      .mockResolvedValue(json({ error: "public_auth_disabled" }, 404));
    vi.stubGlobal("fetch", fetcher);
    expect(await store.loadMeState()).toEqual({ status: "error", account: null });
    expect(await store.loadMeState()).toMatchObject({ status: "ok", account: { user: { id: 7 } } });
    const off = await freshStore();
    expect(await off.loadMeState()).toEqual({ status: "off", account: null });
    expect(await off.loadMeState()).toEqual({ status: "off", account: null });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("view 를 모르는 옛 서버(user·csrfToken 만)도 로그인으로 보고 빈 값으로 채운다", async () => {
    const store = await freshStore();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ user: { id: 7, displayName: "하늘" }, csrfToken: "csrf" })));
    expect(await store.loadMeState()).toEqual({ status: "ok", account: { user: { id: 7, displayName: "하늘" }, csrfToken: "csrf", isMaker: false, providers: [], savedVersion: null } });
  });

  it("로그아웃 답은 1분 동안만 쓴다 — 다른 탭에서 로그인했으면 다음 물음이 안다. 로그인 답은 다시 묻지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await freshStore();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ user: null, csrfToken: null })).mockResolvedValue(json(account));
    vi.stubGlobal("fetch", fetcher);
    expect(await store.loadMeAccount()).toBeNull();
    vi.setSystemTime(Date.now() + 30_000);
    expect(await store.loadMeAccount()).toBeNull();
    vi.setSystemTime(Date.now() + 31_000);
    expect(await store.loadMeAccount()).toMatchObject({ user: { id: 7 } });
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await store.loadMeAccount()).toMatchObject({ user: { id: 7 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("화면으로 돌아오면 로그아웃 답을 다시 묻고, 바뀌었으면 구독한 부품에 알린다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = "visible";
    const win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    const store = await freshStore();
    const fetcher = vi.fn().mockResolvedValueOnce(json({ user: null, csrfToken: null })).mockResolvedValue(json(account));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    store.subscribeMeState(changed);
    await store.loadMeState();
    expect(changed).toHaveBeenCalledTimes(1);
    // 방금 받은 답은 바로 다시 묻지 않는다
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6_000);
    win.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(store.meStateSnapshot()).toMatchObject({ status: "ok", account: { user: { id: 7 } } }));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("recheckMeState 는 로그아웃 답을 바로 다시 묻고, 같은 답이면 다시 그리지 않는다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn(async () => json({ user: null, csrfToken: null }));
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    store.subscribeMeState(changed);
    await store.loadMeState();
    await store.recheckMeState();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("서버가 읽은 계정 넘기기(primeMeAccount)", () => {
  const primed = { user: { id: 7, displayName: "하늘" }, csrfToken: "csrf", isMaker: true, providers: [], savedVersion: null };

  it("아직 받은 답이 없으면 그 계정으로 두고 묻지 않는다", async () => {
    const store = await freshStore();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    store.primeMeAccount(primed);
    expect(await store.loadMeState()).toEqual({ status: "ok", account: primed });
    expect(await store.recheckMeState()).toEqual({ status: "ok", account: primed });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("이미 받은(또는 묻는 중인) 답은 덮지 않는다", async () => {
    const store = await freshStore();
    vi.stubGlobal("fetch", vi.fn(async () => json({ user: null, csrfToken: null })));
    const asking = store.loadMeState();
    store.primeMeAccount(primed);
    expect(await asking).toEqual({ status: "ok", account: null });
    expect(store.meStateSnapshot()).toEqual({ status: "ok", account: null });
  });

  it("서버 그림에서는 아무것도 하지 않는다", async () => {
    vi.stubGlobal("window", undefined);
    const store = await freshStore();
    store.primeMeAccount(primed);
    expect(store.meStateSnapshot()).toBeUndefined();
  });
});

describe("안 읽은 수", () => {
  it("요약이 방금 채운 수는 다시 묻지 않고, 1분이 지나면 묻는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await freshStore();
    const fetcher = vi.fn(async (url: string) => url.endsWith("/unread") ? json({ unread: 5 }) : json(account));
    vi.stubGlobal("fetch", fetcher);
    await store.refreshUnreadCount();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME]);
    vi.setSystemTime(Date.now() + 61_000);
    await store.refreshUnreadCount();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME, "/api/me/notifications/unread"]);
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

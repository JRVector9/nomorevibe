import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 상세의 «내 의견» 읽기(components/product-detail/FeedbackList.tsx) — 로그아웃이면 /api/me/feedback 을 부르지 않는다.
 * 401 을 로그아웃 신호로 쓰면 로그아웃한 방문자마다 상세를 열 때 콘솔에 401 오류가 남았다(2026-10-20 운영 실측).
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ME = "/api/me?view=header";
const account = { user: { id: 7, displayName: "하늘" }, isMaker: false, providers: [], unreadAlerts: 0, savedVersion: "0:0", csrfToken: "csrf" };

async function load() {
  vi.resetModules();
  return (await import("@/components/product-detail/FeedbackList")).loadMineFeedback;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("상세의 내 의견 읽기", () => {
  it("로그아웃이면 /api/me/feedback 을 부르지 않는다", async () => {
    const fetcher = vi.fn(async (url: string) => url === ME ? json({ user: null, csrfToken: null }) : json({}, 500));
    vi.stubGlobal("fetch", fetcher);
    const loadMineFeedback = await load();
    expect(await loadMineFeedback("tiny-cron")).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME]);
  });

  it("로그인 기능이 꺼져 있으면(404) 부르지 않는다", async () => {
    const fetcher = vi.fn(async () => json({ error: "public_auth_disabled" }, 404));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await load())("tiny-cron")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("로그인했으면 내 의견을 읽는다", async () => {
    const mine = [{ id: "f1", authorUserId: 7 }];
    const fetcher = vi.fn(async (url: string) => url === ME ? json(account) : json({ feedback: mine }));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await load())("tiny cron")).toEqual(mine);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME, "/api/me/feedback?slug=tiny%20cron"]);
  });

  it("로그인 상태를 모르면 예전처럼 물어 401 로 로그아웃을 안다", async () => {
    const fetcher = vi.fn(async (url: string) => url === ME ? json({ error: "unavailable" }, 503) : json({ error: "login_required" }, 401));
    vi.stubGlobal("fetch", fetcher);
    expect(await (await load())("tiny-cron")).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME, "/api/me/feedback?slug=tiny-cron"]);
  });

  it("내 의견 응답이 깨졌으면 실패로 알린다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === ME ? json(account) : json({ feedback: "x" })));
    await expect((await load())("tiny-cron")).rejects.toThrow("feedback_unavailable");
  });

  it("다른 탭에서 로그인한 뒤에는 로그아웃 답을 다시 물어 내 의견을 읽는다(1분이 지나거나 의견을 올린 뒤)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let loggedIn = false;
    const fetcher = vi.fn(async (url: string) => url === ME ? json(loggedIn ? account : { user: null, csrfToken: null }) : json({ feedback: [] }));
    vi.stubGlobal("fetch", fetcher);
    const loadMineFeedback = await load();
    expect(await loadMineFeedback("tiny-cron")).toBeNull();
    loggedIn = true;
    vi.setSystemTime(Date.now() + 61_000);
    expect(await loadMineFeedback("tiny-cron")).toEqual([]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ME, ME, "/api/me/feedback?slug=tiny-cron"]);
    // 의견을 올린 직후(FEEDBACK_SUBMITTED)는 시간과 관계없이 다시 묻는다
    vi.resetModules();
    loggedIn = false;
    const store = await import("@/components/me/account-store");
    const fresh = (await import("@/components/product-detail/FeedbackList")).loadMineFeedback;
    expect(await fresh("tiny-cron")).toBeNull();
    loggedIn = true;
    void store.recheckMeState();
    expect(await fresh("tiny-cron")).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAccountCopy, reconcileSaved } from "@/components/home/saved";

describe("reconcileSaved — 계정 목록이 기준, 이 브라우저 것은 묻는다(L4)", () => {
  it("첫 로그인: 서버에 없는 이 브라우저 저장은 지우지 않고 옮길 거리로, 서버에만 있는 것은 더한다", () => {
    const result = reconcileSaved({ local: ["a", "b"], server: ["c", "b"], base: [], pending: {} });
    expect(result.local).toEqual(["a", "b", "c"]);
    expect(result.localOnly).toEqual(["a"]);
    expect(result.base).toEqual(["c", "b"]);
    expect(result.puts).toEqual([]);
  });

  it("지난번 서버에 있었는데 지금 없으면 다른 기기에서 뺀 것 — 여기서도 뺀다", () => {
    const result = reconcileSaved({ local: ["a", "b", "x"], server: ["b"], base: ["a", "b"], pending: {} });
    expect(result.local).toEqual(["b", "x"]);
    expect(result.localOnly).toEqual(["x"]);
  });

  it("서버에만 있는 것은 오래된 것 먼저 뒤에 붙인다(브라우저 목록 순서)", () => {
    const result = reconcileSaved({ local: ["a"], server: ["new", "old", "a"], base: ["a"], pending: {} });
    expect(result.local).toEqual(["a", "old", "new"]);
  });

  it("못 보낸 저장(fenced DB)은 지키고 다시 보낸다 — 서버에 들어가면 풀린다", () => {
    const waiting = reconcileSaved({ local: ["a"], server: [], base: ["a"], pending: { a: "put" } });
    expect(waiting.local).toEqual(["a"]);
    expect(waiting.puts).toEqual(["a"]);
    expect(waiting.pending).toEqual({ a: "put" });
    expect(waiting.localOnly).toEqual([]);
    const done = reconcileSaved({ local: ["a"], server: ["a"], base: [], pending: { a: "put" } });
    expect(done.pending).toEqual({});
    expect(done.puts).toEqual([]);
  });

  it("못 보낸 빼기는 서버에 아직 있어도 이 브라우저에 되살리지 않는다", () => {
    const waiting = reconcileSaved({ local: [], server: ["a", "b"], base: ["a", "b"], pending: { a: "delete" } });
    expect(waiting.local).toEqual(["b"]);
    expect(waiting.deletes).toEqual(["a"]);
    const done = reconcileSaved({ local: ["b"], server: ["b"], base: ["a", "b"], pending: { a: "delete" } });
    expect(done.pending).toEqual({});
    expect(done.local).toEqual(["b"]);
  });

  it("저장은 합집합이고 같은 주소는 한 번만", () => {
    const result = reconcileSaved({ local: ["a", "a", "b"], server: ["b", "b"], base: [], pending: {} });
    expect(result.local).toEqual(["a", "b"]);
    expect(result.base).toEqual(["b"]);
  });
});

describe("forgetAccountCopy — 로그아웃하면 내려받은 사본을 지운다(공용 PC)", () => {
  it("계정에서 온 것만 지우고, 이 브라우저에서만 저장한 것과 못 보낸 저장은 남긴다", () => {
    expect(forgetAccountCopy(["mine", "server", "waiting"], { user: 1, base: ["server", "waiting"], pending: { waiting: "put" } }))
      .toEqual(["mine", "waiting"]);
  });
});

/* ── 브라우저 쪽 동기화 — localStorage·window·fetch 를 바꿔 끼운다 ── */

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Route = (call: Call) => Response | Promise<Response>;

function browser(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const target = new EventTarget();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("window", {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  return { read: (key: string) => JSON.parse(store.get(key) ?? "null") as unknown };
}

function server(route: Route) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    return route(call);
  }));
  return calls;
}

const loggedIn = (call: Call, saved: string[]) => call.url === "/api/me" ? Response.json({ user: { id: 7, displayName: "하늘" }, csrfToken: "c".repeat(64) })
  : call.url === "/api/me/saved?view=slugs" ? Response.json({ slugs: saved }) : null;

async function load() {
  vi.resetModules();
  const saved = await import("@/components/home/saved");
  saved.startSavedSync();
  return saved;
}

describe("브라우저 동기화", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("로그아웃 상태는 지금처럼 이 브라우저 목록만 쓴다", async () => {
    const storage = browser({ "nmb-saved-v1": ["a"] });
    const calls = server(() => Response.json({ user: null, csrfToken: null }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("none"));
    saved.toggleSaved("b");
    expect(storage.read("nmb-saved-v1")).toEqual(["a", "b"]);
    expect(calls.map((call) => call.url)).toEqual(["/api/me"]);
  });

  it("로그인 중 책갈피는 CSRF 를 붙여 서버에도 쓰고, 서버 수를 머리 점에 준다", async () => {
    const storage = browser({ "nmb-saved-v1": [] });
    const calls = server((call) => loggedIn(call, ["s1"]) ?? Response.json({ saved: true, total: 2 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(1));
    expect(storage.read("nmb-saved-v1")).toEqual(["s1"]);
    saved.toggleSaved("s2");
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(2));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/me/saved/s2");
    expect(put.headers["x-csrf-token"]).toBe("c".repeat(64));
    expect((storage.read("nmb-saved-sync-v1") as { pending: object }).pending).toEqual({});
  });

  it("fenced DB(503)면 이 브라우저 저장을 지키고 다음 방문에 다시 보낸다", async () => {
    const storage = browser({ "nmb-saved-v1": [] });
    let fenced = true;
    const calls = server((call) => loggedIn(call, []) ?? (fenced ? Response.json({ error: "public_auth_unavailable" }, { status: 503 }) : Response.json({ saved: true, total: 1 })));
    let saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(0));
    saved.toggleSaved("keep");
    await vi.waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(storage.read("nmb-saved-v1")).toEqual(["keep"]);
    expect((storage.read("nmb-saved-sync-v1") as { pending: object }).pending).toEqual({ keep: "put" });
    fenced = false;
    saved = await load();
    await vi.waitFor(() => expect((storage.read("nmb-saved-sync-v1") as { pending: object }).pending).toEqual({}));
    expect(storage.read("nmb-saved-v1")).toEqual(["keep"]);
    expect(saved.savedAccountSnapshot().offer).toBe(0);
  });

  it("상한(saved_limit)이면 이 브라우저에서도 되돌리고 알린다", async () => {
    const storage = browser({ "nmb-saved-v1": [] });
    server((call) => loggedIn(call, []) ?? Response.json({ error: "saved_limit" }, { status: 409 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("user"));
    saved.toggleSaved("over");
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().notice).toEqual({ kind: "limit" }));
    expect(storage.read("nmb-saved-v1")).toEqual([]);
  });

  it("이 브라우저에만 있는 저장을 묻고, 옮기면 merge 로 보내고 다시 맞춘다", async () => {
    const storage = browser({ "nmb-saved-v1": ["local", "gone"] });
    let account = ["s1"];
    const calls = server((call) => {
      if (call.url === "/api/me/saved/merge") {
        account = ["local", ...account];
        return Response.json({ merged: 1, skipped: 1, total: 2 });
      }
      return loggedIn(call, account) ?? Response.json({ error: "unexpected" }, { status: 500 });
    });
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().offer).toBe(2));
    expect(await saved.mergeBrowserSaved()).toBe(true);
    const merge = calls.find((call) => call.url === "/api/me/saved/merge")!;
    expect(JSON.parse(merge.body!)).toEqual({ slugs: ["local", "gone"] });
    expect(saved.savedAccountSnapshot()).toMatchObject({ offer: 0, notice: { kind: "merged", merged: 1, skipped: 1 } });
    // 건너뛴 주소(내려간 제품)는 이 브라우저에서도 빠진다
    expect(storage.read("nmb-saved-v1")).toEqual(["local", "s1"]);
  });

  it("«나중에»는 계정마다 기억하고 다음 방문에 다시 묻지 않는다", async () => {
    const storage = browser({ "nmb-saved-v1": ["local"] });
    server((call) => loggedIn(call, []) ?? Response.json({}, { status: 500 }));
    let saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().offer).toBe(1));
    saved.postponeMerge();
    expect(storage.read("nmb-saved-merge-later-v1")).toEqual([7]);
    saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(0));
    expect(saved.savedAccountSnapshot().offer).toBe(0);
    expect(storage.read("nmb-saved-v1")).toEqual(["local"]);
  });

  it("로그아웃하면 계정에서 내려받은 사본을 지우고, 계정을 묻지 못하면 지우지 않는다", async () => {
    const sync = { user: 7, base: ["server"], pending: {} };
    let storage = browser({ "nmb-saved-v1": ["mine", "server"], "nmb-saved-sync-v1": sync });
    server(() => Response.json({ error: "down" }, { status: 502 }));
    let saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("none"));
    expect(storage.read("nmb-saved-v1")).toEqual(["mine", "server"]);
    storage = browser({ "nmb-saved-v1": ["mine", "server"], "nmb-saved-sync-v1": sync });
    server(() => Response.json({ user: null, csrfToken: null }));
    saved = await load();
    await vi.waitFor(() => expect(storage.read("nmb-saved-sync-v1")).toBeNull());
    expect(storage.read("nmb-saved-v1")).toEqual(["mine"]);
  });

  it("계정을 묻는 동안 누른 책갈피도 로그인이 확인되면 보낸다", async () => {
    browser({ "nmb-saved-v1": [] });
    let answer!: () => void;
    const asked = new Promise<void>((resolve) => { answer = resolve; });
    const calls = server(async (call) => {
      if (call.url === "/api/me") await asked;
      return loggedIn(call, []) ?? Response.json({ saved: true, total: 1 });
    });
    const saved = await load();
    saved.toggleSaved("early");
    answer();
    await vi.waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url === "/api/me/saved/early")).toBe(true));
  });
});

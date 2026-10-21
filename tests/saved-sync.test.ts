import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAccountCopy, reconcileSaved } from "@/components/home/saved";
import { savableProduct } from "@/components/product-detail/SaveButton";

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

describe("savableProduct — 상세 책갈피는 계정이 받는 제품(savedPublic)에만", () => {
  it("검증·시드 제품만, 개인 프로필은 주인이 있을 때만", () => {
    expect(savableProduct({ status: "verified", category: "Dev" }, true)).toBe(true);
    expect(savableProduct({ status: "seeded", category: "Dev" }, true)).toBe(true);
    expect(savableProduct({ status: "unverified", category: "Dev" }, false)).toBe(false);
    expect(savableProduct({ status: "seeded", category: "Profile" }, true)).toBe(false);
    expect(savableProduct({ status: "seeded", category: "Profile" }, false)).toBe(true);
  });
});

/* ── 브라우저 쪽 동기화 — localStorage·window·fetch 를 바꿔 끼운다 ── */

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Route = (call: Call) => Response | Promise<Response>;

function browser(initial: Record<string, unknown> = {}, { broken = false } = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const target = new EventTarget();
  // broken: 저장소를 끈 WebView — 읽기·쓰기가 모두 던진다
  const guard = <T,>(run: () => T) => () => { if (broken) throw new DOMException("denied", "SecurityError"); return run(); };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => guard(() => store.get(key) ?? null)(),
    setItem: (key: string, value: string) => guard(() => void store.set(key, String(value)))(),
    removeItem: (key: string) => guard(() => void store.delete(key))(),
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

const ME = "/api/me?view=header";
const loggedIn = (call: Call, saved: string[], savedVersion?: string) => call.url === ME ? Response.json({ user: { id: 7, displayName: "하늘" }, csrfToken: "c".repeat(64), savedVersion })
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
    expect(calls.map((call) => call.url)).toEqual([ME]);
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
      if (call.url === "/api/me/saved" && call.method === "POST") {
        account = ["local", ...account];
        return Response.json({ merged: 1, skipped: 1, total: 2 });
      }
      return loggedIn(call, account) ?? Response.json({ error: "unexpected" }, { status: 500 });
    });
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().offer).toBe(2));
    expect(await saved.mergeBrowserSaved()).toBe(true);
    const merge = calls.find((call) => call.url === "/api/me/saved" && call.method === "POST")!;
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

  it.each([["put", [] as string[], ["x"]], ["delete", ["x"], []]] as const)(
    "계정 목록을 받는 사이 끝난 %s 는 늦게 온 옛 목록이 되돌리지 않는다 — 그 목록은 버리고 다시 받는다",
    async (op, before, after) => {
      const storage = browser({ "nmb-saved-v1": before, "nmb-saved-sync-v1": { user: 7, base: before, pending: {} } });
      let account: string[] = [...before];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let lists = 0;
      const calls = server(async (call) => {
        if (call.url === "/api/me/saved?view=slugs") {
          lists += 1;
          // 첫 목록은 누르기 전의 서버 모습 — 저장이 끝난 뒤에야 도착한다
          const snapshot = [...account];
          if (lists === 1) await gate;
          return Response.json({ slugs: snapshot });
        }
        if (call.url === "/api/me/saved/x") {
          account = call.method === "PUT" ? ["x"] : [];
          return Response.json({ saved: call.method === "PUT", total: account.length });
        }
        return loggedIn(call, account) ?? Response.json({}, { status: 500 });
      });
      const saved = await load();
      await vi.waitFor(() => expect(lists).toBe(1));
      saved.toggleSaved("x", op === "put");
      await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/me/saved/x")).toBe(true));
      await vi.waitFor(() => expect((storage.read("nmb-saved-sync-v1") as { base: string[] }).base).toEqual(after));
      release();
      await vi.waitFor(() => expect(lists).toBe(2));
      await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(after.length));
      expect(storage.read("nmb-saved-v1")).toEqual(after);
      expect(storage.read("nmb-saved-sync-v1")).toEqual({ user: 7, base: after, pending: {} });
      expect(account).toEqual(after);
      // 다시 보내지 않는다(되돌리는 PUT·DELETE 가 없다)
      expect(calls.filter((call) => call.url === "/api/me/saved/x")).toHaveLength(1);
    });

  it("로그인해도 이 브라우저의 써봤어요 평가를 묻지 않고 옮기지 않는다(옮기기는 써봤어요 탭에서 묻는다)", async () => {
    browser({ "nmb-saved-v1": [], "nmb-reacted-v1": ["tiny-cron"] });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const calls = server((call) => loggedIn(call, []) ?? Response.json({}, { status: 500 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(0));
    expect(calls.map((call) => call.url)).toEqual([ME, "/api/me/saved?view=slugs"]);
  });

  it("계정을 묻는 동안 누른 책갈피도 로그인이 확인되면 보낸다", async () => {
    browser({ "nmb-saved-v1": [] });
    let answer!: () => void;
    const asked = new Promise<void>((resolve) => { answer = resolve; });
    const calls = server(async (call) => {
      if (call.url === ME) await asked;
      return loggedIn(call, []) ?? Response.json({ saved: true, total: 1 });
    });
    const saved = await load();
    saved.toggleSaved("early");
    answer();
    await vi.waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url === "/api/me/saved/early")).toBe(true));
  });

  it("저장 판이 지난번과 같으면 계정 목록을 다시 받지 않고, 다르면 받는다", async () => {
    const storage = browser({ "nmb-saved-v1": ["s1", "mine"], "nmb-saved-sync-v1": { user: 7, base: ["s1"], pending: {}, version: "1:100" } });
    let calls = server((call) => loggedIn(call, ["s1"], "1:100") ?? Response.json({}, { status: 500 }));
    let saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot()).toMatchObject({ serverCount: 1, offer: 1 }));
    expect(calls.map((call) => call.url)).toEqual([ME]);
    // 다른 기기에서 저장했다 — 판이 바뀌었다
    calls = server((call) => loggedIn(call, ["s2", "s1"], "2:200") ?? Response.json({}, { status: 500 }));
    saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().serverCount).toBe(2));
    expect(calls.map((call) => call.url)).toEqual([ME, "/api/me/saved?view=slugs"]);
    expect(storage.read("nmb-saved-sync-v1")).toEqual({ user: 7, base: ["s2", "s1"], pending: {}, version: "2:200" });
    expect(storage.read("nmb-saved-v1")).toEqual(["s1", "mine", "s2"]);
  });

  it("계정이 받지 않은 저장(목록에 없는 제품 404)은 이 브라우저에서도 되돌리고 알린다 — 옮길 거리로 남기지 않는다", async () => {
    const storage = browser({ "nmb-saved-v1": [] });
    server((call) => loggedIn(call, []) ?? Response.json({ error: "product_not_found" }, { status: 404 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("user"));
    saved.toggleSaved("draft");
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().notice).toEqual({ kind: "unavailable" }));
    expect(storage.read("nmb-saved-v1")).toEqual([]);
    expect((storage.read("nmb-saved-sync-v1") as { pending: object }).pending).toEqual({});
  });

  it("옮길 것이 상한보다 많으면 최근 것부터 상한만큼 보내고, 보내지 않은 것은 지우지 않고 다시 묻는다", async () => {
    const local = Array.from({ length: 600 }, (_, index) => `s-${index}`);
    const storage = browser({ "nmb-saved-v1": local });
    let account: string[] = [];
    const calls = server((call) => {
      if (call.url === "/api/me/saved" && call.method === "POST") {
        account = (JSON.parse(call.body!) as { slugs: string[] }).slugs.slice().reverse();
        return Response.json({ merged: account.length, skipped: 0, total: account.length });
      }
      return loggedIn(call, account) ?? Response.json({}, { status: 500 });
    });
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().offer).toBe(600));
    expect(await saved.mergeBrowserSaved()).toBe(true);
    const sent = (JSON.parse(calls.find((call) => call.method === "POST")!.body!) as { slugs: string[] }).slugs;
    expect(sent).toEqual(local.slice(-500));
    expect(storage.read("nmb-saved-v1")).toHaveLength(600);
    expect(saved.savedAccountSnapshot()).toMatchObject({ serverCount: 500, offer: 100 });
  });

  it("옮기는 중에 뺀 저장은 합치기가 끝난 뒤 빼기를 보낸다 — 늦게 끝난 합치기가 되살리지 않는다", async () => {
    const storage = browser({ "nmb-saved-v1": ["x", "y"] });
    let account: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const calls = server(async (call) => {
      if (call.url === "/api/me/saved" && call.method === "POST") {
        await gate;
        account = [...(JSON.parse(call.body!) as { slugs: string[] }).slugs].reverse();
        order.push("merge");
        return Response.json({ merged: 2, skipped: 0, total: 2 });
      }
      if (call.url === "/api/me/saved/x" && call.method === "DELETE") {
        account = account.filter((slug) => slug !== "x");
        order.push("delete");
        return Response.json({ saved: false, total: account.length });
      }
      return loggedIn(call, account) ?? Response.json({}, { status: 500 });
    });
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().offer).toBe(2));
    const merged = saved.mergeBrowserSaved();
    await vi.waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    saved.toggleSaved("x", false);
    // 합치기가 끝나기 전에는 빼기를 보내지 않는다
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    release();
    expect(await merged).toBe(true);
    await vi.waitFor(() => expect(order).toEqual(["merge", "delete"]));
    await vi.waitFor(() => expect((storage.read("nmb-saved-sync-v1") as { pending: object }).pending).toEqual({}));
    expect(account).toEqual(["y"]);
    expect(storage.read("nmb-saved-v1")).toEqual(["y"]);
  });

  it("첫 문서에서 로그인 상태를 묻지 못해도 그동안 누른 것을 버리지 않고, 다시 물어 답을 받으면 보낸다", async () => {
    const storage = browser({ "nmb-saved-v1": ["s1"] });
    let down = true;
    const calls = server((call) => down && call.url === ME ? Response.json({ error: "public_auth_unavailable" }, { status: 503 })
      : loggedIn(call, ["s1"]) ?? Response.json({ saved: false, total: 0 }));
    const saved = await load();
    await vi.waitFor(() => expect(calls.filter((call) => call.url === ME)).toHaveLength(1));
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("none"));
    down = false;
    // 저장 탭(서버가 그린 계정 목록)에서 뺐다 — 누를 때 다시 묻고, 로그인이 확인되면 빼기를 보낸다
    saved.toggleSaved("s1", false);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/me/saved/s1")).toBe(true));
    expect(saved.savedAccountSnapshot().status).toBe("user");
    expect(storage.read("nmb-saved-v1")).toEqual([]);
  });

  it("지난 계정 기록이 있는데 묻지 못했으면 쌓아 두고, 나중에 답을 받으면(화면 복귀 등) 그 문서 안에서 보낸다", async () => {
    browser({ "nmb-saved-v1": ["s1"], "nmb-saved-sync-v1": { user: 7, base: ["s1"], pending: {} } });
    let down = true;
    const calls = server((call) => down && call.url === ME ? Response.json({ error: "down" }, { status: 502 })
      : loggedIn(call, ["s1"]) ?? Response.json({ saved: false, total: 0 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("none"));
    down = false;
    // 머리 메뉴가 다시 물어 로그인 답을 받았다
    const store = await import("@/components/me/account-store");
    await store.loadMeState();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("user"));
    saved.toggleSaved("s1", false);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/me/saved/s1")).toBe(true));
  });

  it("저장소를 쓸 수 없는 브라우저도 이 문서 안에서는 빼기·되돌리기를 서버에 보낸다", async () => {
    browser({}, { broken: true });
    const calls = server((call) => loggedIn(call, ["s1"]) ?? Response.json({ saved: call.method === "PUT", total: 0 }));
    const saved = await load();
    await vi.waitFor(() => expect(saved.savedAccountSnapshot().status).toBe("user"));
    await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/me/saved?view=slugs")).toBe(true));
    saved.toggleSaved("s1", false);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/me/saved/s1")).toBe(true));
    saved.toggleSaved("s1", true);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url === "/api/me/saved/s1")).toBe(true));
  });
});

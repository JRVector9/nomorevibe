import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteReactionRequest, putReactionRequest, readReactionPanel, type ReactionBody } from "@/components/feedback/reaction-api";

/** 써봤어요 쓰기 요청 — 쿠키 없는 익명 쓰기(400 visitor_required)는 GET 으로 쿠키를 받고 한 번만 다시 보낸다 */

const body: ReactionBody = { verdict: "good", tags: [], comment: null, source: "panel", device: "desktop", locale: "ko", website: "" };
const mine = { verdict: "good", tags: [], comment: null, commentState: null, triedVerified: false, updatedAt: "2026-10-20T00:00:00.000Z" };
const visitorRequired = () => Response.json({ error: "visitor_required" }, { status: 400 });
const invalidCsrf = () => Response.json({ error: "invalid_csrf" }, { status: 403 });
const TOKEN = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; csrf?: string; body?: string };
function stubFetch(answers: Array<() => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const csrf = (init?.headers as Record<string, string> | undefined)?.["x-csrf-token"];
    calls.push({ url, method: init?.method ?? "GET", ...(csrf ? { csrf } : {}), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }));
  return calls;
}

describe("putReactionRequest", () => {
  it("쿠키가 없다는 답이면 GET 으로 쿠키를 받고 한 번 다시 보낸다", async () => {
    const calls = stubFetch([visitorRequired, () => Response.json({ mine: null, summary: null }), () => Response.json({ mine, summary: null, signedIn: false })]);
    expect(await putReactionRequest("tiny-cron", body, null)).toEqual({ ok: true, mine, summary: null, csrfToken: null, signedIn: false });
    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "/api/products/tiny-cron/reactions", method: "PUT" },
      // 쿠키만 받으면 된다 — 내 평가는 찾지 않는다
      { url: "/api/products/tiny-cron/reactions?reacted=0", method: "GET" },
      { url: "/api/products/tiny-cron/reactions", method: "PUT" },
    ]);
  });

  it("다시 보내도 쿠키가 없으면(쿠키를 막은 브라우저) 더 돌지 않고 실패로 알린다", async () => {
    const calls = stubFetch([visitorRequired, () => Response.json({ mine: null, summary: null }), visitorRequired]);
    expect(await putReactionRequest("tiny-cron", body, null)).toEqual({ ok: false, errorKey: "try.error.failed" });
    expect(calls).toHaveLength(3);
  });

  it("GET 이 실패하면 다시 보내지 않는다. 다른 400 은 그대로 알린다", async () => {
    const failed = stubFetch([visitorRequired, () => Response.json({ error: "reaction_unavailable" }, { status: 503 })]);
    expect(await putReactionRequest("tiny-cron", body, null)).toEqual({ ok: false, errorKey: "try.error.failed" });
    expect(failed.map((call) => call.method)).toEqual(["PUT", "GET"]);
    const calls = stubFetch([() => Response.json({ error: "reaction_invalid" }, { status: 400 })]);
    expect(await putReactionRequest("tiny-cron", body, null)).toEqual({ ok: false, errorKey: "try.error.invalid" });
    expect(calls).toHaveLength(1);
  });

  it("판을 연 뒤 다른 탭에서 로그인했으면(403 invalid_csrf) 지금 세션의 CSRF 값을 받아 한 번만 다시 보내고 그 값을 돌려준다", async () => {
    const calls = stubFetch([invalidCsrf, () => Response.json({ mine: null, summary: null, signedIn: true, csrfToken: TOKEN }),
      () => Response.json({ mine, summary: null, signedIn: true })]);
    expect(await putReactionRequest("tiny-cron", { ...body, tags: undefined, comment: undefined }, null, { refreshCsrf: true }))
      .toEqual({ ok: true, mine, summary: null, csrfToken: TOKEN, signedIn: true });
    expect(calls.map(({ url, method, csrf }) => ({ url, method, csrf }))).toEqual([
      { url: "/api/products/tiny-cron/reactions", method: "PUT", csrf: undefined },
      { url: "/api/products/tiny-cron/reactions?reacted=0", method: "GET", csrf: undefined },
      { url: "/api/products/tiny-cron/reactions", method: "PUT", csrf: TOKEN },
    ]);
    // 평가만 보낸 몸통은 태그·한 줄을 싣지 않는다(서버가 남겨 둔 값을 둔다)
    expect(JSON.parse(calls[2].body!)).not.toHaveProperty("tags");
    expect(JSON.parse(calls[2].body!)).not.toHaveProperty("comment");
  });

  it("새 값도 같거나 없으면 더 돌지 않는다. 마이페이지(refreshCsrf 없음)는 다시 받지 않는다", async () => {
    const same = stubFetch([invalidCsrf, () => Response.json({ mine: null, summary: null, signedIn: true, csrfToken: TOKEN })]);
    expect(await putReactionRequest("tiny-cron", body, TOKEN, { refreshCsrf: true })).toEqual({ ok: false, errorKey: "try.error.failed" });
    expect(same).toHaveLength(2);
    const fixed = stubFetch([invalidCsrf]);
    expect(await putReactionRequest("tiny-cron", body, TOKEN)).toEqual({ ok: false, errorKey: "try.error.failed" });
    expect(fixed).toHaveLength(1);
  });

  it("지우기도 CSRF 값을 다시 받아 한 번 더 보낸다", async () => {
    const calls = stubFetch([invalidCsrf, () => Response.json({ mine: null, summary: null, signedIn: true, csrfToken: TOKEN }),
      () => Response.json({ deleted: true, summary: null, signedIn: true })]);
    expect(await deleteReactionRequest("tiny-cron", null, { refreshCsrf: true })).toEqual({ ok: true, summary: null, csrfToken: TOKEN, signedIn: true });
    expect(calls.map((call) => [call.method, call.csrf])).toEqual([["DELETE", undefined], ["GET", undefined], ["DELETE", TOKEN]]);
  });
});

describe("readReactionPanel", () => {
  it("못 읽으면 「평가 없음」이 아니라 null(모름), 꺼져 있으면 hidden", async () => {
    stubFetch([() => Response.json({ error: "reaction_unavailable" }, { status: 503 })]);
    expect(await readReactionPanel("tiny-cron", true)).toBeNull();
    stubFetch([() => { throw new TypeError("network"); }]);
    expect(await readReactionPanel("tiny-cron", true)).toBeNull();
    stubFetch([() => Response.json({ error: "reactions_disabled" }, { status: 404 })]);
    expect(await readReactionPanel("tiny-cron", true)).toBe("hidden");
  });

  it("이 브라우저가 평가한 기억이 없을 때만 reacted=0 을 붙인다(모르면 붙이지 않는다)", async () => {
    const answer = () => Response.json({ mine, summary: null, signedIn: false, csrfToken: null });
    const calls = stubFetch([answer, answer, answer]);
    expect(await readReactionPanel("tiny-cron", false)).toEqual({ mine, summary: null, signedIn: false, csrfToken: null });
    await readReactionPanel("tiny-cron", true);
    await readReactionPanel("tiny-cron", null);
    expect(calls.map((call) => call.url)).toEqual(["/api/products/tiny-cron/reactions?reacted=0", "/api/products/tiny-cron/reactions", "/api/products/tiny-cron/reactions"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { putReactionRequest, type ReactionBody } from "@/components/feedback/reaction-api";

/** 써봤어요 쓰기 요청 — 쿠키 없는 익명 쓰기(400 visitor_required)는 GET 으로 쿠키를 받고 한 번만 다시 보낸다 */

const body: ReactionBody = { verdict: "good", tags: [], comment: null, source: "panel", device: "desktop", locale: "ko", website: "" };
const mine = { verdict: "good", tags: [], comment: null, commentState: null, triedVerified: false, updatedAt: "2026-10-20T00:00:00.000Z" };
const visitorRequired = () => Response.json({ error: "visitor_required" }, { status: 400 });

afterEach(() => vi.unstubAllGlobals());

function stubFetch(answers: Array<() => Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }));
  return calls;
}

describe("putReactionRequest", () => {
  it("쿠키가 없다는 답이면 GET 으로 쿠키를 받고 한 번 다시 보낸다", async () => {
    const calls = stubFetch([visitorRequired, () => Response.json({ mine: null, summary: null }), () => Response.json({ mine, summary: null })]);
    expect(await putReactionRequest("tiny-cron", body, null)).toEqual({ ok: true, mine, summary: null });
    expect(calls).toEqual([
      { url: "/api/products/tiny-cron/reactions", method: "PUT" },
      { url: "/api/products/tiny-cron/reactions", method: "GET" },
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
});

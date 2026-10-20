import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserReactionsToMerge, mergeBrowserReactions, postponeReactionMerge, rememberReacted } from "@/components/feedback/reacted";

/** 이 브라우저의 익명 평가를 계정으로 옮기기(써봤어요 탭에서 묻고 나서만) — 옮긴 기록은 성공한 뒤에만, 계정마다 */

type Call = { url: string; method: string; body?: string };
let store: Map<string, string>;
let calls: Call[];
let answer: (call: Call) => Response;

beforeEach(() => {
  store = new Map([["nmb-reacted-v1", JSON.stringify(["tiny-cron", "other"])]]);
  calls = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", body: init.body as string | undefined };
    calls.push(call);
    return answer(call);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const browserList = (slugs: string[]) => () => Response.json({ reactions: slugs.map((slug) => ({ slug })) });

describe("browserReactionsToMerge · mergeBrowserReactions", () => {
  it("이 쿠키의 익명 평가가 남은 slug 만 묻고, 옮기기가 실패하면 기록을 남기지 않아 다음에 다시 묻는다", async () => {
    answer = browserList(["tiny-cron"]);
    expect(await browserReactionsToMerge(7)).toEqual(["tiny-cron"]);
    expect(calls).toEqual([{ url: "/api/me/reactions/browser?slugs=tiny-cron%2Cother", method: "GET", body: undefined }]);
    answer = () => Response.json({ error: "reaction_unavailable" }, { status: 503 });
    expect(await mergeBrowserReactions(7, "c".repeat(64), ["tiny-cron"])).toBeNull();
    expect(store.has("nmb-reacted-merged-v1")).toBe(false);
    answer = browserList(["tiny-cron"]);
    expect(await browserReactionsToMerge(7)).toEqual(["tiny-cron"]);
  });

  it("옮긴 뒤에는 그 계정에 같은 slug 를 다시 묻지도 보내지도 않는다 — 다른 계정·이 브라우저에서 다시 남긴 평가는 다시 묻는다", async () => {
    answer = () => Response.json({ merged: 1 });
    expect(await mergeBrowserReactions(7, "c".repeat(64), ["tiny-cron"])).toBe(1);
    expect(calls[0]).toMatchObject({ url: "/api/me/reactions/merge", method: "POST", body: JSON.stringify({ slugs: ["tiny-cron"] }) });
    calls = [];
    answer = browserList([]);
    expect(await browserReactionsToMerge(7)).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual(["/api/me/reactions/browser?slugs=other"]);
    calls = [];
    await browserReactionsToMerge(8);
    expect(calls.map((call) => call.url)).toEqual(["/api/me/reactions/browser?slugs=tiny-cron%2Cother"]);
    rememberReacted("tiny-cron");
    calls = [];
    await browserReactionsToMerge(7);
    expect(calls.map((call) => call.url)).toEqual(["/api/me/reactions/browser?slugs=tiny-cron%2Cother"]);
  });

  it("«나중에»는 계정마다 기억하고 그 계정에는 서버를 부르지 않고 묻지 않는다", async () => {
    answer = browserList(["tiny-cron"]);
    postponeReactionMerge(7);
    expect(await browserReactionsToMerge(7)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await browserReactionsToMerge(8)).toEqual(["tiny-cron"]);
  });
});

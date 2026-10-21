import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserReactionsToMerge, hasReacted, mergeBrowserReactions, postponeReactionMerge, reactedSlugs, rememberReacted,
} from "@/components/feedback/reacted";

/** 이 브라우저의 익명 평가를 계정으로 옮기기(써봤어요 탭에서 묻고 나서만) — 옮긴 기록은 성공한 뒤에만, 계정마다 */

type Call = { url: string; method: string; body?: string };
let store: Map<string, string>;
let calls: Call[];
let answer: (call: Call) => Response | Promise<Response>;

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
    answer = browserList(["tiny-cron", "other"]);
    expect(await browserReactionsToMerge(7)).toEqual(["tiny-cron", "other"]);
    expect(calls).toEqual([{ url: "/api/me/reactions/browser?slugs=tiny-cron%2Cother", method: "GET", body: undefined }]);
    answer = () => Response.json({ error: "reaction_unavailable" }, { status: 503 });
    expect(await mergeBrowserReactions(7, "c".repeat(64), ["tiny-cron"])).toBeNull();
    expect(store.has("nmb-reacted-merged-v1")).toBe(false);
    expect(reactedSlugs()).toEqual(["tiny-cron", "other"]);
    answer = browserList(["tiny-cron", "other"]);
    expect(await browserReactionsToMerge(7)).toEqual(["tiny-cron", "other"]);
  });

  it("옮긴 slug 는 이제 계정 행이라 이 브라우저 목록에서 빠진다 — 이 브라우저에서 다시 남기면 다시 묻는다", async () => {
    answer = () => Response.json({ merged: 1 });
    expect(await mergeBrowserReactions(7, "c".repeat(64), ["tiny-cron"])).toBe(1);
    expect(calls[0]).toMatchObject({ url: "/api/me/reactions/merge", method: "POST", body: JSON.stringify({ slugs: ["tiny-cron"] }) });
    expect(reactedSlugs()).toEqual(["other"]);
    calls = [];
    answer = browserList(["other"]);
    expect(await browserReactionsToMerge(8)).toEqual(["other"]);
    expect(calls.map((call) => call.url)).toEqual(["/api/me/reactions/browser?slugs=other"]);
    rememberReacted("tiny-cron");
    calls = [];
    answer = browserList(["tiny-cron", "other"]);
    expect(await browserReactionsToMerge(7)).toEqual(["tiny-cron", "other"]);
    expect(calls.map((call) => call.url)).toEqual(["/api/me/reactions/browser?slugs=tiny-cron%2Cother"]);
  });

  it("서버에 이 쿠키의 익명 행이 없다고 답한 slug 는 목록에서 빼 다시 묻지 않는다 — 읽기가 실패하면 빼지 않는다", async () => {
    answer = () => Response.json({ error: "reaction_unavailable" }, { status: 503 });
    expect(await browserReactionsToMerge(7)).toEqual([]);
    expect(reactedSlugs()).toEqual(["tiny-cron", "other"]);
    answer = browserList(["other"]);
    expect(await browserReactionsToMerge(7)).toEqual(["other"]);
    expect(reactedSlugs()).toEqual(["other"]);
    calls = [];
    answer = browserList([]);
    await browserReactionsToMerge(7);
    expect(reactedSlugs()).toEqual([]);
    calls = [];
    // 물을 것이 없으면 서버를 부르지 않는다
    expect(await browserReactionsToMerge(7)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("100개 묶음은 차례로 기다리지 않고 함께 보낸다", async () => {
    store.set("nmb-reacted-v1", JSON.stringify(Array.from({ length: 250 }, (_, index) => `p${index}`)));
    let open = 0;
    let most = 0;
    answer = async (call) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return browserList(decodeURIComponent(call.url.split("slugs=")[1]).split(","))();
    };
    expect(await browserReactionsToMerge(7)).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(most).toBe(3);
  });

  it("«나중에»는 계정마다 기억하고 그 계정에는 서버를 부르지 않고 묻지 않는다", async () => {
    answer = browserList(["tiny-cron"]);
    postponeReactionMerge(7);
    expect(await browserReactionsToMerge(7)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await browserReactionsToMerge(8)).toEqual(["tiny-cron"]);
  });
});

describe("hasReacted", () => {
  it("기억한 slug 면 true, 아니면 false, 저장소를 못 읽으면 null(모름)", () => {
    expect(hasReacted("tiny-cron")).toBe(true);
    expect(hasReacted("unseen")).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("SecurityError"); }, setItem: () => undefined });
    expect(hasReacted("tiny-cron")).toBeNull();
  });
});

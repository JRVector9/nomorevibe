import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  connectionAllowsPrefetch,
  HOVER_DELAY_MS,
  IntentPrefetcher,
  intentPrefetchPath,
  MIN_GAP_MS,
  REUSE_MS,
  type IntentAnchor,
} from "@/lib/web/intent-prefetch";

const ORIGIN = "https://nomorevibe.com";
const home = { origin: ORIGIN, pathname: "/", search: "" };
const link = (href: string, extra: Partial<IntentAnchor> = {}): IntentAnchor =>
  ({ href: new URL(href, ORIGIN).href, target: "", download: false, ...extra });

describe("intentPrefetchPath", () => {
  it("accepts product detail, list, category and ranking pages", () => {
    expect(intentPrefetchPath(link("/p/evidence-studio"), home)).toBe("/p/evidence-studio");
    expect(intentPrefetchPath(link("/p/name.with.dots"), home)).toBe("/p/name.with.dots");
    expect(intentPrefetchPath(link("/popular"), home)).toBe("/popular");
    expect(intentPrefetchPath(link("/rising"), home)).toBe("/rising");
    expect(intentPrefetchPath(link("/talk"), home)).toBe("/talk");
    expect(intentPrefetchPath(link("/c/dev?sort=recent"), home)).toBe("/c/dev?sort=recent");
    expect(intentPrefetchPath(link("/rankings/weekly"), home)).toBe("/rankings/weekly");
    expect(intentPrefetchPath(link("/launch#verify"), home)).toBe("/launch");
    const detail = { origin: ORIGIN, pathname: "/p/evidence-studio", search: "" };
    expect(intentPrefetchPath(link("/#projects"), detail)).toBe("/");
    expect(intentPrefetchPath(link("/?sort=recent&shown=18"), home)).toBe("/?sort=recent&shown=18");
  });

  it("keeps the visitor's language and never prefetches a language switch or a /ko redirect", () => {
    const english = { origin: ORIGIN, pathname: "/en", search: "" };
    expect(intentPrefetchPath(link("/en/p/evidence-studio"), english)).toBe("/en/p/evidence-studio");
    expect(intentPrefetchPath(link("/zh-Hant/c/dev"), { origin: ORIGIN, pathname: "/zh-Hant/popular", search: "" })).toBe("/zh-Hant/c/dev");
    expect(intentPrefetchPath(link("/p/evidence-studio"), english)).toBeNull();
    expect(intentPrefetchPath(link("/en/p/evidence-studio"), home)).toBeNull();
    expect(intentPrefetchPath(link("/ko/p/evidence-studio"), home)).toBeNull();
  });

  it("skips private, uncached, machine and non-page addresses", () => {
    for (const href of [
      "/login", "/login?returnTo=%2Fp%2Fx", "/me", "/me/alerts", "/feedback/12", "/p/evidence-studio/github",
      "/admin", "/admin/models", "/api/products/x", "/go/evidence-studio", "/badge/evidence-studio",
      "/feed.xml", "/install.sh", "/skill.md", "/policy", "/policy#listing", "/p", "/c", "/p/a/b",
    ]) expect(intentPrefetchPath(link(href), home), href).toBeNull();
  });

  it("skips search and the client-only methodology dialog", () => {
    expect(intentPrefetchPath(link("/?q=agent"), home)).toBeNull();
    expect(intentPrefetchPath(link("/c/dev?q=agent&sort=recent"), home)).toBeNull();
    expect(intentPrefetchPath(link("/?metric=born"), home)).toBeNull();
    expect(intentPrefetchPath(link("/?metric=popular#popular"), home)).toBeNull();
  });

  it("skips hash links on the same page, other origins, new tabs and downloads", () => {
    expect(intentPrefetchPath(link("/#popular"), home)).toBeNull();
    const category = { origin: ORIGIN, pathname: "/c/dev", search: "?sort=recent" };
    expect(intentPrefetchPath(link("/c/dev?sort=recent#list"), category)).toBeNull();
    expect(intentPrefetchPath(link("/c/dev?sort=stars"), category)).toBe("/c/dev?sort=stars");
    expect(intentPrefetchPath({ href: "https://github.com/example/repo", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath({ href: "https://evil.example/p/x", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath({ href: "http://nomorevibe.com/p/x", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath({ href: "https://user:pw@nomorevibe.com/p/x", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath({ href: "mailto:hello@nomorevibe.com", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath({ href: "javascript:alert(1)", target: "", download: false }, home)).toBeNull();
    expect(intentPrefetchPath(link("/p/x", { target: "_blank" }), home)).toBeNull();
    expect(intentPrefetchPath(link("/p/x", { target: "_self" }), home)).toBe("/p/x");
    expect(intentPrefetchPath(link("/p/x", { download: true }), home)).toBeNull();
    expect(intentPrefetchPath({ href: "http://[", target: "", download: false }, home)).toBeNull();
  });
});

describe("connectionAllowsPrefetch", () => {
  it("skips save-data and 2G connections", () => {
    expect(connectionAllowsPrefetch(undefined)).toBe(true);
    expect(connectionAllowsPrefetch({ effectiveType: "4g" })).toBe(true);
    expect(connectionAllowsPrefetch({ effectiveType: "3g", saveData: false })).toBe(true);
    expect(connectionAllowsPrefetch({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(connectionAllowsPrefetch({ effectiveType: "2g" })).toBe(false);
    expect(connectionAllowsPrefetch({ effectiveType: "slow-2g" })).toBe(false);
  });
});

/** 가짜 시계 — setTimer 를 시각 순서대로 실행한다 */
function harness(options: { prefetch?: (path: string) => void } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const issued: { path: string; at: number }[] = [];
  const prefetcher = new IntentPrefetcher({
    prefetch: options.prefetch ?? ((path) => issued.push({ path, at: now })),
    now: () => now,
    setTimer: (callback, ms) => { const id = nextId++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { prefetcher, issued, advance, pendingTimers: () => timers.size };
}

describe("IntentPrefetcher", () => {
  it("prefetches one hovered link once the pointer rests for the hover delay", () => {
    const { prefetcher, issued, advance } = harness();
    prefetcher.enter("/p/a");
    advance(HOVER_DELAY_MS - 1);
    expect(issued).toEqual([]);
    advance(1);
    expect(issued).toEqual([{ path: "/p/a", at: HOVER_DELAY_MS }]);
    // moving inside the same link (child elements) does not restart or repeat it
    prefetcher.enter("/p/a");
    advance(5_000);
    expect(issued).toHaveLength(1);
  });

  it("ignores a pointer that passes over a link faster than the hover delay", () => {
    const { prefetcher, issued, advance, pendingTimers } = harness();
    prefetcher.enter("/p/a");
    advance(HOVER_DELAY_MS - 20);
    prefetcher.leave();
    advance(1_000);
    expect(issued).toEqual([]);
    expect(pendingTimers()).toBe(0);
  });

  it("bounds a sweep across a 20-card grid to one prefetch per gap, the last one only if the pointer stays", () => {
    for (const dwell of [40, 100, 150, 250]) {
      const { prefetcher, issued, advance } = harness();
      for (let card = 0; card < 20; card++) {
        prefetcher.enter(`/p/card-${card}`);
        advance(dwell);
      }
      prefetcher.leave();
      advance(5_000);
      const sweep = 20 * dwell;
      expect(issued.length, `dwell ${dwell}ms`).toBeLessThanOrEqual(dwell < HOVER_DELAY_MS ? 0 : Math.ceil(sweep / MIN_GAP_MS));
      for (let i = 1; i < issued.length; i++) expect(issued[i].at - issued[i - 1].at).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
  });

  it("prefetches the link the pointer settles on after the gap", () => {
    const { prefetcher, issued, advance } = harness();
    prefetcher.enter("/p/a");
    advance(200);
    prefetcher.enter("/p/b");
    advance(300);
    expect(issued.map((item) => item.path)).toEqual(["/p/a"]);
    advance(MIN_GAP_MS);
    expect(issued).toEqual([{ path: "/p/a", at: HOVER_DELAY_MS }, { path: "/p/b", at: HOVER_DELAY_MS + MIN_GAP_MS }]);
  });

  it("does not prefetch the same address again within the reuse window", () => {
    const { prefetcher, issued, advance } = harness();
    prefetcher.enter("/p/a");
    advance(500);
    prefetcher.leave();
    advance(2_000);
    prefetcher.enter("/p/a");
    advance(2_000);
    expect(issued).toHaveLength(1);
    prefetcher.leave();
    advance(REUSE_MS);
    prefetcher.enter("/p/a");
    advance(HOVER_DELAY_MS);
    expect(issued.map((item) => item.path)).toEqual(["/p/a", "/p/a"]);
  });

  it("drops a pending prefetch when the visitor presses, and stays quiet for a gap", () => {
    const { prefetcher, issued, advance, pendingTimers } = harness();
    prefetcher.enter("/p/a");
    advance(HOVER_DELAY_MS - 10);
    prefetcher.cancel(); // pointerdown / keydown: the navigation starts now
    expect(pendingTimers()).toBe(0);
    // small movement over the pressed link must not start a prefetch while the navigation runs
    prefetcher.enter("/p/a");
    advance(MIN_GAP_MS - 1);
    expect(issued).toEqual([]);
    advance(1);
    // still resting on it a full gap later (no navigation happened): prefetch then
    expect(issued).toEqual([{ path: "/p/a", at: HOVER_DELAY_MS - 10 + MIN_GAP_MS }]);
  });

  it("never prefetches at the moment of a press", () => {
    const { prefetcher, issued, advance } = harness();
    prefetcher.cancel();
    prefetcher.enter("/p/a");
    prefetcher.cancel();
    advance(5_000);
    expect(issued).toEqual([]);
  });

  it("only leaves the link that was left", () => {
    const { prefetcher, issued, advance } = harness();
    prefetcher.enter("/p/a");
    prefetcher.leave("/p/other");
    advance(HOVER_DELAY_MS);
    expect(issued.map((item) => item.path)).toEqual(["/p/a"]);
  });

  it("keeps working when the router throws, and stops after dispose", () => {
    let calls = 0;
    const { prefetcher, advance, pendingTimers } = harness({ prefetch: () => { calls++; throw new Error("router not ready"); } });
    prefetcher.enter("/p/a");
    advance(HOVER_DELAY_MS);
    prefetcher.enter("/p/b");
    advance(MIN_GAP_MS);
    expect(calls).toBe(2);
    prefetcher.enter("/p/c");
    prefetcher.dispose();
    expect(pendingTimers()).toBe(0);
    advance(5_000);
    expect(calls).toBe(2);
  });
});

describe("public shell wiring", () => {
  it("mounts intent prefetch once in the public shell, not in the operator area", () => {
    expect(readFileSync("components/home/PublicShell.tsx", "utf8")).toMatch(/<IntentPrefetch \/>/);
    expect(readFileSync("app/(operator)/layout.tsx", "utf8")).not.toMatch(/IntentPrefetch/);
  });

  it("prefetches the whole page on hover and keyboard focus only, never on touch or press", () => {
    const source = readFileSync("components/IntentPrefetch.tsx", "utf8");
    expect(source).toMatch(/const FULL_PREFETCH = "full"/);
    expect(source).toMatch(/event\.pointerType !== "mouse" && event\.pointerType !== "pen"/);
    expect(source).not.toMatch(/touchstart|prefetcher\.enter\([^)]*TOUCH/);
    expect(source).toMatch(/addEventListener\("pointerdown", onPress/);
    expect(source).toMatch(/:focus-visible/);
  });

  it("keeps the client cache of prefetched pages at Next's 30-second minimum", () => {
    expect(readFileSync("next.config.ts", "utf8")).toMatch(/staleTimes:\s*\{\s*static:\s*30\s*\}/);
    expect(REUSE_MS).toBe(30_000);
  });
});

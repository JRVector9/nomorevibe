import { afterEach, describe, expect, it } from "vitest";
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import robots from "@/app/robots";

const training = ["GPTBot", "ClaudeBot", "CCBot", "Bytespider", "Meta-ExternalAgent", "Amazonbot", "Google-CloudVertexBot", "Applebot-Extended", "AI2Bot"];
const search = ["Googlebot", "Bingbot", "Yeti", "Daum", "Applebot", "DuckDuckBot", "OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Amzn-SearchBot", "Amzn-User", "facebookexternalhit", "Twitterbot"];

// Evaluate emitted groups, including the more-specific-agent rule that overrides '*'.
function rulesFor(text: string, agent: string) {
  const groups = text.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split("\n").map(line => line.split(/:\s*/, 2));
    const agents = lines.filter(([key]) => key.toLowerCase() === "user-agent").map(([, value]) => value.toLowerCase());
    const specificity = Math.max(-1, ...agents.map(token => token === "*" ? 0 : agent.toLowerCase().includes(token) ? token.length : -1));
    return { lines, specificity };
  });
  const max = Math.max(...groups.map(group => group.specificity));
  return groups.filter(group => group.specificity === max).flatMap(group => group.lines);
}
function allowed(text: string, agent: string, path: string) {
  const matches = rulesFor(text, agent).filter(([key, value]) => /^(allow|disallow)$/i.test(key) && value && path.startsWith(value));
  matches.sort((a, b) => b[1].length - a[1].length || Number(b[0].toLowerCase() === "allow") - Number(a[0].toLowerCase() === "allow"));
  return !matches.length || matches[0][0].toLowerCase() === "allow";
}

afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; });
describe("anti-scrape SEO robots output", () => {
  it.each(training)("denies training agent %s on all public paths", agent => {
    const text = resolveRobots(robots());
    expect(allowed(text, agent, "/")).toBe(false);
    expect(allowed(text, agent, "/p/example")).toBe(false);
    expect(rulesFor(text, agent)).toContainEqual(["Disallow", "/"]);
  });
  it.each(search)("allows search/answer agent %s and preserves private-path exclusions", agent => {
    const text = resolveRobots(robots());
    for (const path of ["/", "/p/example", "/en/p/example", "/llms.txt", "/sitemap.xml"]) expect(allowed(text, agent, path)).toBe(true);
    for (const path of ["/go/example", "/admin", "/api/products"]) expect(allowed(text, agent, path)).toBe(false);
  });
  it("emits Content-Signal and the runtime canonical sitemap, with unknown bots retaining existing rules", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://nomorevibe.com/";
    const text = resolveRobots(robots());
    expect(text).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no\n");
    expect(text).toContain("Sitemap: https://nomorevibe.com/sitemap.xml\n");
    for (const line of ["Allow: /\n", "Disallow: /go/\n", "Disallow: /admin\n", "Disallow: /api/\n"]) expect(text).toContain(line);
    expect(allowed(text, "UnknownCrawler", "/p/example")).toBe(true);
    expect(allowed(text, "UnknownCrawler", "/api/products")).toBe(false);
  });
});

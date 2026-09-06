import { describe, expect, it } from "vitest";
import { extractSiteRepositoryKeys } from "@/lib/domain/evidence/providers/site-fingerprint";
describe("site repository relationships", () => {
 it("accepts explicit source anchors and preserves multiple repositories for conflict review", () => {
  expect(extractSiteRepositoryKeys('<a href="https://github.com/Acme/App">Source code</a>', 'https://app.example')).toEqual(['acme/app']);
  expect(extractSiteRepositoryKeys('<a href="https://github.com/a/one">Source code</a><a href="https://github.com/b/two">Repository</a>', 'https://app.example')).toEqual(['a/one','b/two']);
 });
 it("ignores social profiles, examples, comments, scripts, canonical metadata and misleading hosts", () => {
  const html = '<a href="https://github.com/acme">GitHub</a><a href="https://github.com/framework/lib">GitHub</a><a href="https://github.com/a/b">Example repository</a><pre><a href="https://github.com/a/b">Source code</a></pre><!-- <a href="https://github.com/a/b">Source code</a> --><script><a href="https://github.com/a/b">Source code</a></script><a href="https://github.com.bad/a/b">Source code</a><link rel="canonical" href="https://github.com/a/b">';
  expect(extractSiteRepositoryKeys(html, 'https://app.example')).toEqual([]);
 });
 it("resolves protocol-relative anchors against the fetched final URL", () => {
  expect(extractSiteRepositoryKeys('<a aria-label="View source" href="//github.com/a/b"><svg></svg></a>', 'https://redirect.example/path')).toEqual(['a/b']);
 });
});
it("reads explicit source links after large inline assets without truncating competing repository links", () => {
 const html = '<a href="https://github.com/a/one">Source code</a><svg><path d="' + 'x'.repeat(700 * 1024) + '"></path></svg>'
  + '<a href="https://github.com/TradingGoose/TradingGoose-Studio" aria-label="GitHub repository - 0 stars"><svg></svg></a>';
 expect(extractSiteRepositoryKeys(html, "https://www.tradinggoose.ai/en")).toEqual(["a/one", "tradinggoose/tradinggoose-studio"]);
});
it("does not establish a relationship from a page at or over the strict two MiB boundary", () => {
 const html = '<a href="https://github.com/a/one">Source code</a>' + 'x'.repeat(2 * 1024 * 1024);
 expect(extractSiteRepositoryKeys(html, "https://app.example")).toEqual([]);
});

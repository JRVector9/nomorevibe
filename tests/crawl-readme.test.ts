import { describe, expect, it } from "vitest";
import { fetchReadmeSample, readmeText, README_SAMPLE_LIMIT } from "@/lib/crawl/readme";
import type { CappedFetchResult } from "@/lib/net/fetch";

const ok = (text: string): CappedFetchResult => ({ ok: true, status: 200, finalUrl: "x", headers: new Headers(), body: Buffer.from(text) });
const missing: CappedFetchResult = { ok: false, reason: "http", status: 404 };

describe("README 앞부분", () => {
  it("removes embedded NUL before README text reaches PostgreSQL review storage", async () => {
    expect(await fetchReadmeSample("acme/app", async () => ok("# App\0\nUseful\0 product")))
      .toBe("App\nUseful product");
  });

  it("배지·이미지·HTML은 버리고 링크 목적지와 설치 명령은 남긴다", () => {
    const text = readmeText([
      "# Oigo", "![build](https://img.shields.io/badge.svg) <img src=x>", "",
      "Dictation for macOS. [Download](https://example.com/oigo.dmg)", "", "", "```", "brew install oigo", "```",
    ].join("\n"));
    expect(text).toBe("Oigo\n\nDictation for macOS. Download (https://example.com/oigo.dmg)\n\n```\nbrew install oigo\n```");
    expect(readmeText("a".repeat(README_SAMPLE_LIMIT + 50))).toHaveLength(README_SAMPLE_LIMIT);
  });

  it("흔한 이름을 차례로 찾고, 없으면 없음(\"\")으로 표시해 다시 찾지 않는다", async () => {
    const asked: string[] = [];
    const found = await fetchReadmeSample("acme/app", async (url) => { asked.push(url.split("/HEAD/")[1]); return url.endsWith("/README") ? ok("hello") : missing; });
    expect(found).toBe("hello");
    expect(asked).toEqual(["README.md", "readme.md", "README"]);
    expect(await fetchReadmeSample("acme/none", async () => missing)).toBe("");
  });

  it("잠깐의 실패는 null — 다음 심사에서 다시 받는다. 너무 큰 README 는 없음으로 친다", async () => {
    expect(await fetchReadmeSample("acme/app", async () => ({ ok: false, reason: "timeout" }))).toBeNull();
    expect(await fetchReadmeSample("acme/app", async () => ({ ok: false, reason: "too_large" }))).toBe("");
  });

  it("레포 이름이 아니면 요청하지 않는다", async () => {
    let called = false;
    expect(await fetchReadmeSample("../../etc", async () => { called = true; return missing; })).toBe("");
    expect(called).toBe(false);
  });
});

it("preserves distinct demo/docs destinations including reference links and autolinks", () => {
  const text = readmeText('[Live demo](https://demo.example/app) [Docs][docs] <https://status.example>\n\n[docs]: https://docs.example/guide');
  expect(text).toContain('Live demo (https://demo.example/app)');
  expect(text).toContain('Docs (https://docs.example/guide)');
  expect(text).toContain('https://status.example');
});
it("does not retain executable or credential-bearing destinations", () => {
  const text = readmeText('[run](javascript:alert) [secret](https://user:pass@example.com)');
  expect(text).not.toContain('javascript:');
  expect(text).not.toContain('user:pass');
});

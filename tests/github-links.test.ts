import { describe, expect, it } from "vitest";
import { extractGithubLinks, linksOwnGithub } from "@/lib/crawl/github-links";

describe("extractGithubLinks — 페이지가 공개한 GitHub 링크", () => {
  it("아이콘·글자 링크를 가리지 않고 owner/repo 로 모은다", () => {
    const html = `<a href="https://github.com/LodyAI/Lody" aria-label="GitHub"><svg/></a>
      <a href='https://www.github.com/LodyAI/Lody.git'>Star</a>
      <a href="https://github.com/someone">me</a>`;
    expect(extractGithubLinks(html, "https://lody.ai")).toEqual(["lodyai/lody", "someone"]);
  });

  it("GitHub 의 기능 페이지와 다른 호스트는 세지 않는다", () => {
    const html = `<a href="https://github.com/features/copilot">x</a><a href="https://github.com/sponsors/me">x</a>
      <a href="https://gist.github.com/me/1">x</a><a href="https://example.com/github.com/me">x</a><a href="/local">x</a>`;
    expect(extractGithubLinks(html, "https://a.test")).toEqual([]);
  });

  it("최대 20개까지만 담는다", () => {
    const html = Array.from({ length: 30 }, (_, i) => `<a href="https://github.com/u${i}/r">x</a>`).join("");
    expect(extractGithubLinks(html, "https://a.test")).toHaveLength(20);
  });
});

describe("linksOwnGithub — 제작자의 GitHub 인가", () => {
  it("레포 주인에게 가는 링크만 센다(대소문자 무시)", () => {
    expect(linksOwnGithub("LodyAI/Lody", ["lodyai/lody"])).toBe(true);
    expect(linksOwnGithub("LodyAI/Lody", ["lodyai"])).toBe(true);
    expect(linksOwnGithub("LodyAI/Lody", ["vercel/next.js"])).toBe(false);
    expect(linksOwnGithub("LodyAI/Lody", undefined)).toBe(false);
  });
});

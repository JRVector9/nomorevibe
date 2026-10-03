import { describe, expect, it } from "vitest";
import { readmeText } from "@/lib/crawl/readme";
import { readmeExcerpt } from "@/lib/domain/products/readme-excerpt";

const tagline = "PostHog automatically diagnoses problems.";
const body = [
  "Docs - Community - Roadmap - Why PostHog? - Changelog - Bug reports",
  "",
  "PostHog is the open source platform for building self-driving products",
  "",
  "PostHog (https://posthog.com/) provides every tool you need to build a successful product, and captures all the context agents need to proactively diagnose problems, uncover opportunities, and ship fixes:",
  "",
  "- Self-driving mode (https://posthog.com/docs/self-driving): Turn signals in your product data into researched reports and pull requests you review and merge.",
  "- Product analytics (https://posthog.com/product-analytics): Autocapture or manually instrument event-based analytics to understand user behavior",
].join("\n");

describe("README 발췌", () => {
  it("링크 나열 줄은 건너뛰고 첫 문단부터 600자 안에서 문단 경계로 자른다", () => {
    const text = readmeExcerpt(body, tagline)!;
    expect(text.startsWith("PostHog is the open source platform")).toBe(true);
    expect(text).toContain("Self-driving mode");
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("Docs - Community");
  });
  it("괄호 안의 주소는 지운다", () => {
    expect(readmeExcerpt(body, tagline)).not.toContain("https://posthog.com/docs");
  });
  it("소개와 같거나 80자 미만이면 없다", () => {
    expect(readmeExcerpt(tagline, tagline)).toBeNull();
    expect(readmeExcerpt("Short.", tagline)).toBeNull();
    expect(readmeExcerpt(null, tagline)).toBeNull();
  });
  it("뱃지 줄 뒤의 80자 미만 한 문장에서 멈추지 않고 다음 긴 문단까지 잇는다", () => {
    // 저장된 README 에서 뱃지는 이미지가 빠지고 " (주소)" 만 남은 줄이 된다(lib/crawl/readme.ts)
    const readme = [
      " (https://github.com/ni-c/caldav-mcp/actions/workflows/ci.yml)",
      " (https://www.npmjs.com/package/@ni-c/caldav-mcp)",
      "",
      "Your calendars, in Claude.",
      "",
      "A Model Context Protocol (https://modelcontextprotocol.io/) (MCP) server for CalDAV, the open calendar",
      "standard behind Nextcloud, Radicale, Baikal, Fastmail and iCloud.",
    ].join("\n");
    expect(readmeExcerpt(readme, "MCP server for CalDAV calendars")).toBe([
      "Your calendars, in Claude.",
      "",
      "A Model Context Protocol (MCP) server for CalDAV, the open calendar",
      "standard behind Nextcloud, Radicale, Baikal, Fastmail and iCloud.",
    ].join("\n"));
  });
  it("제목 줄은 버린다 — '# 제목' 그대로든, 저장 때 #이 떨어진 짧은 한 줄이든", () => {
    const markdown = [
      "# Madeira",
      "",
      "Madeira runs Windows games on iOS.",
      "",
      "## Install",
      "",
      "Download the IPA from the releases page and sideload it with AltStore or your own developer certificate.",
    ].join("\n");
    const expected = "Madeira runs Windows games on iOS.\n\nDownload the IPA from the releases page and sideload it with AltStore or your own developer certificate.";
    expect(readmeExcerpt(markdown, "Windows games on iOS")).toBe(expected);
    expect(readmeExcerpt(readmeText(markdown), "Windows games on iOS")).toBe(expected);
  });
  it("첫 문단부터 600자를 넘으면 그 문단을 600자 안의 문장 경계에서 자른다", () => {
    const sentence = "TimerOutputs is a small Julia package that prints formatted timings for labelled sections of a program. ";
    const text = readmeExcerpt(`TimerOutputs\n\n${sentence.repeat(8).trim()}\n\nInstallation`, "Formatted timings for Julia")!;
    expect(text.startsWith("TimerOutputs is")).toBe(true);
    expect(text.endsWith("of a program.")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.length).toBeGreaterThan(500);
  });
  it("코드 블록과 표는 버리고 굵게 표시는 푼다", () => {
    const readme = [
      "**Your bank, in Claude.** Read-only, self-hosted, one user.",
      "",
      "```bash",
      "npx bank-mcp init",
      "",
      "npx bank-mcp serve",
      "```",
      "",
      "| Bank | Status |",
      "|---|---|",
      "| Revolut | supported |",
      "",
      "It connects to your banks through Enable Banking (https://enablebanking.com/) and exposes them to Claude as an **MCP",
      "connector**. No payments, no third party holding your data.",
    ].join("\n");
    expect(readmeExcerpt(readme, "Ask Claude about your balance")).toBe([
      "Your bank, in Claude. Read-only, self-hosted, one user.",
      "",
      "It connects to your banks through Enable Banking and exposes them to Claude as an MCP",
      "connector. No payments, no third party holding your data.",
    ].join("\n"));
  });
  it("프레임워크가 만들어 준 README 그대로면 없다", () => {
    const nextjs = readmeText([
      "This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).",
      "",
      "## Getting Started",
      "",
      "First, run the development server:",
      "",
      "```bash",
      "npm run dev",
      "```",
      "",
      "Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.",
    ].join("\n"));
    const vite = readmeText("# React + TypeScript + Vite\n\nThis template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.\n\nCurrently, two official plugins are available:");
    expect(readmeExcerpt(nextjs, tagline)).toBeNull();
    expect(readmeExcerpt(vite, tagline)).toBeNull();
  });
});

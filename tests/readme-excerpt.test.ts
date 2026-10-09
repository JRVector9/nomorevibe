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

  it("이름·십진수·16진수 엔티티를 본문 글자로 풀고 줄 사이 공백을 정리한다", () => {
    const encoded = "Atlas &amp; Compass helps teams collect &quot;notes&quot;, keep &#39;decisions&#39; together, and share progress&nbsp;without losing context. &#x1F680; &copy;";
    expect(readmeExcerpt(encoded, tagline)).toBe('Atlas & Compass helps teams collect "notes", keep \'decisions\' together, and share progress without losing context. 🚀 ©');
  });

  it("알 수 없는 엔티티와 세미콜론 없는 일반 글은 그대로 두고 한 번만 푼다", () => {
    const text = "The workspace keeps &unknown; and &copycat as ordinary text while &amp;amp; becomes one literal &amp; reference for readers.";
    expect(readmeExcerpt(text, tagline)).toBe("The workspace keeps &unknown; and &copycat as ordinary text while &amp; becomes one literal & reference for readers.");
    expect(readmeExcerpt("The workspace keeps invalid numeric references &#0; and &#x110000; readable while preserving the rest of this complete sentence.", tagline))
      .toBe("The workspace keeps invalid numeric references � and � readable while preserving the rest of this complete sentence.");
  });

  it("인용 접두사와 알림 표시는 버리되 본문·문단·비교 기호는 보존한다", () => {
    const first = "The workspace helps teams record decisions and review project progress without losing the original context.";
    const second = "The filter keeps values > 5 and quoted examples intact while readers inspect the evidence together.";
    expect(readmeExcerpt(`> [!NOTE]\n> ${first}\n>\n> > ${second}`, tagline)).toBe(`${first}\n\n${second}`);
    expect(readmeExcerpt(`> \`\`\`sh\n> npm run install\n> \`\`\`\n\n${first}`, tagline)).toBe(first);
  });

  it.each([
    "이 도구는 팀의 작업 기록과 일정 정보를 한곳에 모으고 필요한 내용을 검색하여 회의 준비와 진행 상황 확인을 돕습니다.",
    "这是一款帮助团队整理工作记录和项目进展的协作工具，可以搜索讨论内容并保留每一次决策的依据。",
    "このツールはチームの作業記録と予定をまとめ、必要な情報を検索して会議の準備と進捗の確認を支援します。",
  ])("80자 미만의 CJK 본문은 별도 최소 분량으로 남긴다: %s", (text) => {
    expect(text.length).toBeLessThan(80);
    expect(readmeExcerpt(text, tagline)).toBe(text);
    expect(readmeExcerpt(text, text)).toBeNull();
  });

  it("실제 36자 일본어 제품 소개도 본문으로 남긴다", () => {
    const text = "iPad で ひとりでも、向かい合って ふたりでも あそべる ゲームばこ";
    expect(readmeExcerpt(`${text}\n\n https://oekazuma.github.io/asobibako/`, tagline)).toBe(text);
  });

  it("띄어쓰기 없는 CJK 본문을 제목으로 버리지 않고 짧은 제목과 명시한 제목은 제외한다", () => {
    const text = "这是一款帮助团队整理工作记录和项目进展的协作工具，可以搜索讨论内容并保留每一次决策的依据";
    expect(readmeExcerpt(`项目介绍\n\n# ${text}\n\n${text}`, tagline)).toBe(text);
    expect(readmeExcerpt("프로젝트 소개\n\n安装方法\n\nはじめに", tagline)).toBeNull();
    expect(readmeExcerpt("A short English sentence with one 字 still stays below the English minimum.", tagline)).toBeNull();
  });

  it("긴 CJK 본문은 띄어쓰기 없는 문장 경계에서도 600자 안으로 자른다", () => {
    const sentence = "这是一款帮助团队整理工作记录和项目进展的协作工具，可以搜索讨论内容并保留每一次决策的依据。";
    const repeats = Math.floor(600 / sentence.length);
    expect(readmeExcerpt(sentence.repeat(20), tagline)).toBe(sentence.repeat(repeats));
  });

  it("목록 기호는 •로, 인라인 코드는 따옴표만 떼서 평문으로 — 감사의 Moa README(UX-17)", () => {
    // detail-moa-d.jpg 에 그대로 보이던 백틱과 '- ' 목록
    const readme = [
      "Moa",
      "",
      "Next.js App Router + Feature-Sliced Design(`src/`) + Supabase로 만든 개인 자산 관리 앱입니다. 거래를 기록하고 월별 흐름을 봅니다.",
      "",
      "- 거래 기록 — 수입·지출을 날짜별로 기록하고 분류합니다",
      "- TanStack Query, Zustand, Supabase (`@supabase/ssr`)",
      "* [x] 월별 예산과 남은 금액을 한눈에 보여 줍니다",
    ].join("\n");
    expect(readmeExcerpt(readme, "개인 자산 관리 앱")).toBe([
      "Next.js App Router + Feature-Sliced Design(src/) + Supabase로 만든 개인 자산 관리 앱입니다. 거래를 기록하고 월별 흐름을 봅니다.",
      "",
      "• 거래 기록 — 수입·지출을 날짜별로 기록하고 분류합니다",
      "• TanStack Query, Zustand, Supabase (@supabase/ssr)",
      "• 월별 예산과 남은 금액을 한눈에 보여 줍니다",
    ].join("\n"));
  });

  it("배지·HTML 잔재는 지우고 링크는 이름만, 강조는 글자만 남긴다 — 낱말 안 밑줄과 코드 안 기호는 그대로", () => {
    const readme = [
      '<p align="center"><img src="docs/logo.png" width="120" alt="Atlas"></p>',
      '<h1 align="center">Atlas</h1>',
      "<!-- badges -->",
      "[![npm](https://img.shields.io/npm/v/atlas.svg)](https://www.npmjs.com/package/atlas) [![CI][ci-badge]][ci-url] ![license](https://img.shields.io/badge/license-MIT-blue)",
      "",
      "---",
      "",
      "## Why Atlas",
      "Atlas is a *fast*, __local-first__ note app with `snake_case_ids`, `**kwargs` support and ~~no~~ sync built in.",
      "See the [docs](https://atlas.dev/docs) or the [changelog][changes] — my_config_file stays as written.",
    ].join("\n");
    expect(readmeExcerpt(readme, "Local-first notes")).toBe([
      "Atlas is a fast, local-first note app with snake_case_ids, **kwargs support and no sync built in.",
      "See the docs or the changelog — my_config_file stays as written.",
    ].join("\n"));
  });

  it("README 안의 날것 태그는 글로 남기지 않고 지운다 — 상세는 발췌를 글자로만 그린다", () => {
    const readme = 'Sketchpad turns rough wireframes into components <script>alert("x")</script> and <img src=x onerror="alert(1)"> exports them to React with one command.';
    const text = readmeExcerpt(readme, tagline)!;
    expect(text).not.toMatch(/<\/?(?:script|img)/i);
    expect(text).not.toContain("onerror");
    expect(text).toContain("Sketchpad turns rough wireframes into components");
    expect(text).toContain("exports them to React with one command.");
  });

  it("저장된 README(lib/crawl/readme.ts 를 거친 글)에서도 참조형 배지가 남지 않는다", () => {
    const stored = readmeText([
      "[![npm][npm-badge]][npm-url] [![Build](https://github.com/acme/kit/actions/workflows/ci.yml/badge.svg)](https://github.com/acme/kit/actions)",
      "",
      "Kit is a small toolkit for building command line apps in TypeScript with typed flags and helpful errors.",
      "",
      "[npm-badge]: https://img.shields.io/npm/v/kit.svg",
      "[npm-url]: https://www.npmjs.com/package/kit",
    ].join("\n"));
    expect(readmeExcerpt(stored, "CLI toolkit")).toBe("Kit is a small toolkit for building command line apps in TypeScript with typed flags and helpful errors.");
  });

  it("엔티티를 풀어도 태그 문자열은 글로 남고 소개와 같은 본문은 제외한다", () => {
    const text = 'The examples keep &lt;script&gt;alert(&quot;sample&quot;)&lt;/script&gt; as literal source text, without changing the surrounding explanation.';
    const expected = 'The examples keep <script>alert("sample")</script> as literal source text, without changing the surrounding explanation.';
    expect(readmeExcerpt(text, tagline)).toBe(expected);
    expect(readmeExcerpt(text, expected)).toBeNull();
  });
});

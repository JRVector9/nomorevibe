import { describe, expect, it } from "vitest";
import { normalizedProductName, prettyRepoName, reviewProductName } from "@/lib/domain/products/display-name";

const gh = (repo: string) => `https://github.com/${repo}`;

describe("reviewProductName — 2026-10-08 UX 감사(UX-33)의 이름들", () => {
  it("일반어 제목은 저장소 이름으로", () => {
    expect(reviewProductName("首页", gh("someone/shuiyun-notes"))).toMatchObject({ issues: ["generic"], proposed: "Shuiyun Notes" });
    expect(reviewProductName("Home Page", gh("acme/nemovia"))).toMatchObject({ issues: ["generic"], proposed: "Nemovia" });
    expect(reviewProductName("홈", gh("acme/ogu-ogu"))).toMatchObject({ issues: ["generic"], proposed: "Ogu Ogu" });
    // 뒤쪽이 저장소와 이어지면 그 이름을 쓴다
    expect(reviewProductName("Home | TradeFlow WMS", gh("acme/tradeflow-wms"))).toMatchObject({ issues: ["generic"], proposed: "TradeFlow WMS" });
    // 저장소 이름도 흔한 것이면 내세울 이름이 없다 — 사람이 본다
    expect(reviewProductName("index", gh("acme/website"))).toMatchObject({ issues: ["generic"], proposed: null });
    expect(reviewProductName("Home", null)).toMatchObject({ issues: ["generic"], proposed: null });
  });

  it("슬로건 구분자 뒤가 길면 앞쪽 이름만", () => {
    expect(reviewProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toMatchObject({ issues: ["slogan_tail"], proposed: "Wireshark" });
    expect(reviewProductName("Notion — The AI workspace that works for you", gh("acme/notion-clone"))).toMatchObject({ issues: ["slogan_tail"], proposed: "Notion" });
    expect(reviewProductName("AppFlowy: Open Source Notion Alternative", gh("AppFlowy-IO/AppFlowy"))).toMatchObject({ issues: ["slogan_tail"], proposed: "AppFlowy" });
    // 이름이 뒤에 있으면 저장소와 이어지는 쪽을 쓴다(2026-09-13 표본의 실제 제목)
    expect(reviewProductName("台灣包車旅遊・機場接送｜RelayGo 專業包車平台", gh("acme/relaygo"))).toMatchObject({ issues: ["slogan_tail"], proposed: "RelayGo" });
    expect(reviewProductName("LoanPilot AI • Borrower Intake Automation", gh("acme/loanpilot"))).toMatchObject({ issues: ["slogan_tail"], proposed: "LoanPilot AI" });
  });

  it("이름이 아닌 문구는 저장소 이름으로", () => {
    expect(reviewProductName("Flexible Open-Source ERP & CRM for SMBs", gh("frappe/erpnext"))).toMatchObject({ issues: ["slogan"], proposed: "Erpnext" });
    expect(reviewProductName("The AI Workspace", gh("acme/atlas"))).toMatchObject({ issues: ["slogan"], proposed: "Atlas" });
  });

  it("40자를 넘으면 그 안의 저장소 이름, 없으면 저장소 이름", () => {
    expect(reviewProductName("Two Prices for the Same Model and How I Built Claude Burst", gh("acme/claude-burst")))
      .toMatchObject({ issues: ["too_long"], proposed: "Claude Burst" });
    expect(reviewProductName("Preserving Long-Tailed Expert Information in MoE Tuning", gh("acme/ExpertCondenser")))
      .toMatchObject({ issues: ["too_long"], proposed: "ExpertCondenser" });
  });

  it("전부 대문자와 이모지 접두는 정리한다", () => {
    expect(reviewProductName("LINKEDIN AGENT", gh("acme/li-outreach"))).toMatchObject({ issues: ["all_caps"], proposed: "Linkedin Agent" });
    // 저장소가 섞어 쓴 표기를 갖고 있으면 그것을 쓴다
    expect(reviewProductName("DEEPSEEKAGENTS", gh("acme/DeepSeekAgents"))).toMatchObject({ issues: ["all_caps"], proposed: "DeepSeekAgents" });
    // 짧은 약어는 두고 흔한 낱말만 고친다
    expect(reviewProductName("CRM DASHBOARD FOR AGENCIES", gh("acme/agency-crm"))).toMatchObject({ issues: ["all_caps"], proposed: "CRM Dashboard for Agencies" });
    expect(reviewProductName("🚀 transformer-architecture", gh("acme/transformer-architecture"))).toMatchObject({ issues: ["emoji_prefix"], proposed: "transformer-architecture" });
    expect(reviewProductName("✨🔥 Prompt Studio", gh("acme/prompt-studio"))).toMatchObject({ issues: ["emoji_prefix"], proposed: "Prompt Studio" });
  });
});

describe("reviewProductName — 멀쩡한 이름은 건드리지 않는다", () => {
  const good: [string, string | null][] = [
    ["Visual Studio Code", gh("microsoft/vscode")],
    ["Home Assistant", gh("home-assistant/core")],
    ["The Algorithms", gh("TheAlgorithms/Python")],
    ["Tools for Humanity", gh("acme/world-id")],
    ["AWS CLI", gh("aws/aws-cli")],
    ["NASA", gh("nasa/openmct")],
    ["MITRE ATT&CK®", gh("mitre/cti")],
    ["FFmpeg", gh("FFmpeg/FFmpeg")],
    ["n8n", gh("n8n-io/n8n")],
    ["AFFiNE", gh("toeverything/AFFiNE")],
    ["Open WebUI", gh("open-webui/open-webui")],
    ["Amazon Bedrock - AWS", gh("acme/bedrock-demo")],
    ["e-commerce-kit", gh("someone/shop")],
    ["Rock Paper Scissors", gh("acme/rps")],
    ["Draw.io", gh("jgraph/drawio")],
    ["C|Net", gh("acme/cnet")],
    ["가계부", gh("acme/gagyebu")],
    ["오구오구 가계부", null],
    ["Mend Renovate", gh("renovatebot/renovate")],
    ["Awesome List of AI Tools", gh("acme/awesome-ai-tools")],
    ["TradeFlow WMS", gh("acme/tradeflow-wms")],
    // owner/repo 꼴은 화면이 이미 줄인다
    ["acme/claude-burst", gh("acme/claude-burst")],
  ];
  it.each(good)("%s", (name, repoUrl) => {
    expect(reviewProductName(name, repoUrl)).toBeNull();
    expect(normalizedProductName(name, repoUrl)).toBe(name);
  });
});

describe("prettyRepoName", () => {
  it("소문자 저장소는 낱말 첫 글자를 올리고 약어는 대문자로, 섞어 쓴 표기는 지킨다", () => {
    expect(prettyRepoName(gh("acme/ai-chat-ui"))).toBe("AI Chat UI");
    expect(prettyRepoName(gh("acme/Open-WebUI"))).toBe("Open WebUI");
    expect(prettyRepoName(gh("acme/nasib.github.io"))).toBeNull();
    expect(prettyRepoName(gh("acme/portfolio"))).toBeNull();
    expect(prettyRepoName(null)).toBeNull();
  });
});

describe("normalizedProductName — 발행할 때 고친 이름을 쓴다", () => {
  it("제안이 있으면 제안, 없으면 그대로", () => {
    expect(normalizedProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toBe("Wireshark");
    expect(normalizedProductName("Home", gh("acme/frontend"))).toBe("Home");
  });
});

describe("제안의 출처(source) — 제목 안의 말만 자동으로 쓴다(2026-10-09 공개분 표본)", () => {
  it("제목 안의 말로 고친 것은 title, 저장소 이름으로 대신한 것은 repo", () => {
    expect(reviewProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toMatchObject({ proposed: "Wireshark", source: "title" });
    expect(reviewProductName("LINKEDIN AGENT", gh("acme/li-outreach"))).toMatchObject({ proposed: "Linkedin Agent", source: "title" });
    expect(reviewProductName("Home | TradeFlow WMS", gh("acme/tradeflow-wms"))).toMatchObject({ proposed: "TradeFlow WMS", source: "title" });
    expect(reviewProductName("The AI Workspace", gh("acme/atlas"))).toMatchObject({ proposed: "Atlas", source: "repo" });
    expect(reviewProductName("首页", gh("someone/shuiyun-notes"))).toMatchObject({ proposed: "Shuiyun Notes", source: "repo" });
    expect(reviewProductName("Home", null)).toMatchObject({ proposed: null, source: null });
  });

  it("발행 이름은 title 제안만 쓰고, 저장소 이름 대신은 원래 이름을 둔다 — 사람이 관리자 화면에서 고른다", () => {
    expect(normalizedProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toBe("Wireshark");
    // 실제로 틀렸던 대신: 'AgentKit: AI Agent Integrations & MCP Gateway' → 'Authstack'
    expect(normalizedProductName("AgentKit: AI Agent Integrations & MCP Gateway", gh("acme/authstack"))).toBe("AgentKit: AI Agent Integrations & MCP Gateway");
    expect(normalizedProductName("The AI Workspace", gh("acme/atlas"))).toBe("The AI Workspace");
  });

  it("그림 문자를 떼면 글자가 거의 안 남는 이름은 두다", () => {
    expect(reviewProductName("🐋 vs 🦞", gh("acme/whale-vs-lobster"))).toBeNull();
    expect(reviewProductName("📡 AI Agent Radar", gh("acme/ai-agent-radar"))).toMatchObject({ issues: ["emoji_prefix"], proposed: "AI Agent Radar", source: "title" });
  });

  it("로마자 밖의 글자가 섞인 대문자 이름은 대소문자를 고치지 않는다", () => {
    const review = reviewProductName("🔥 BỘ TÀI LIỆU AI AGENTIC 1 NGƯỜI (0Đ)", gh("acme/ai-agentic"));
    expect(review?.issues).not.toContain("all_caps");
    expect(review?.proposed).toBe("BỘ TÀI LIỆU AI AGENTIC 1 NGƯỜI (0Đ)");
  });
});

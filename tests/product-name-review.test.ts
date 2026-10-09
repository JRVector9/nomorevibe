import { describe, expect, it } from "vitest";
import { normalizedProductName, prettyRepoName, reviewProductName } from "@/lib/domain/products/display-name";

const gh = (repo: string) => `https://github.com/${repo}`;

describe("reviewProductName — 2026-10-08 UX 감사(UX-33)의 이름들", () => {
  it("일반어 제목은 저장소 이름으로", () => {
    expect(reviewProductName("首页", gh("someone/shuiyun-notes"))).toEqual({ issues: ["generic"], proposed: "Shuiyun Notes" });
    expect(reviewProductName("Home Page", gh("acme/nemovia"))).toEqual({ issues: ["generic"], proposed: "Nemovia" });
    expect(reviewProductName("홈", gh("acme/ogu-ogu"))).toEqual({ issues: ["generic"], proposed: "Ogu Ogu" });
    // 뒤쪽이 저장소와 이어지면 그 이름을 쓴다
    expect(reviewProductName("Home | TradeFlow WMS", gh("acme/tradeflow-wms"))).toEqual({ issues: ["generic"], proposed: "TradeFlow WMS" });
    // 저장소 이름도 흔한 것이면 내세울 이름이 없다 — 사람이 본다
    expect(reviewProductName("index", gh("acme/website"))).toEqual({ issues: ["generic"], proposed: null });
    expect(reviewProductName("Home", null)).toEqual({ issues: ["generic"], proposed: null });
  });

  it("슬로건 구분자 뒤가 길면 앞쪽 이름만", () => {
    expect(reviewProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toEqual({ issues: ["slogan_tail"], proposed: "Wireshark" });
    expect(reviewProductName("Notion — The AI workspace that works for you", gh("acme/notion-clone"))).toEqual({ issues: ["slogan_tail"], proposed: "Notion" });
    expect(reviewProductName("AppFlowy: Open Source Notion Alternative", gh("AppFlowy-IO/AppFlowy"))).toEqual({ issues: ["slogan_tail"], proposed: "AppFlowy" });
    // 이름이 뒤에 있으면 저장소와 이어지는 쪽을 쓴다(2026-09-13 표본의 실제 제목)
    expect(reviewProductName("台灣包車旅遊・機場接送｜RelayGo 專業包車平台", gh("acme/relaygo"))).toEqual({ issues: ["slogan_tail"], proposed: "RelayGo" });
    expect(reviewProductName("LoanPilot AI • Borrower Intake Automation", gh("acme/loanpilot"))).toEqual({ issues: ["slogan_tail"], proposed: "LoanPilot AI" });
  });

  it("이름이 아닌 문구는 저장소 이름으로", () => {
    expect(reviewProductName("Flexible Open-Source ERP & CRM for SMBs", gh("frappe/erpnext"))).toEqual({ issues: ["slogan"], proposed: "Erpnext" });
    expect(reviewProductName("The AI Workspace", gh("acme/atlas"))).toEqual({ issues: ["slogan"], proposed: "Atlas" });
  });

  it("40자를 넘으면 그 안의 저장소 이름, 없으면 저장소 이름", () => {
    expect(reviewProductName("Two Prices for the Same Model and How I Built Claude Burst", gh("acme/claude-burst")))
      .toEqual({ issues: ["too_long"], proposed: "Claude Burst" });
    expect(reviewProductName("Preserving Long-Tailed Expert Information in MoE Tuning", gh("acme/ExpertCondenser")))
      .toEqual({ issues: ["too_long"], proposed: "ExpertCondenser" });
  });

  it("전부 대문자와 이모지 접두는 정리한다", () => {
    expect(reviewProductName("LINKEDIN AGENT", gh("acme/li-outreach"))).toEqual({ issues: ["all_caps"], proposed: "Linkedin Agent" });
    // 저장소가 섞어 쓴 표기를 갖고 있으면 그것을 쓴다
    expect(reviewProductName("DEEPSEEKAGENTS", gh("acme/DeepSeekAgents"))).toEqual({ issues: ["all_caps"], proposed: "DeepSeekAgents" });
    // 짧은 약어는 두고 흔한 낱말만 고친다
    expect(reviewProductName("CRM DASHBOARD FOR AGENCIES", gh("acme/agency-crm"))).toEqual({ issues: ["all_caps"], proposed: "CRM Dashboard for Agencies" });
    expect(reviewProductName("🚀 transformer-architecture", gh("acme/transformer-architecture"))).toEqual({ issues: ["emoji_prefix"], proposed: "transformer-architecture" });
    expect(reviewProductName("✨🔥 Prompt Studio", gh("acme/prompt-studio"))).toEqual({ issues: ["emoji_prefix"], proposed: "Prompt Studio" });
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

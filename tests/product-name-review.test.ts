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
  it("제목 안의 말로 고친 것은 title, 짐작한 것은 guess, 저장소 이름으로 대신한 것은 repo", () => {
    expect(reviewProductName("Wireshark • Go Deep", gh("wireshark/wireshark"))).toMatchObject({ proposed: "Wireshark", source: "title" });
    expect(reviewProductName("DEEPSEEKAGENTS", gh("acme/DeepSeekAgents"))).toMatchObject({ proposed: "DeepSeekAgents", source: "title" });
    // 대소문자만 저장소에서 가져오고 띄어쓰기·하이픈은 제목 것을 둔다
    expect(reviewProductName("ZARVIS MOBILE", gh("acme/ZarvisMobile"))).toMatchObject({ proposed: "Zarvis Mobile", source: "title" });
    expect(reviewProductName("D-AGROBUSINESS", gh("acme/D_AgroBusiness"))).toMatchObject({ proposed: "D-AgroBusiness", source: "title" });
    expect(reviewProductName("LINKEDIN AGENT", gh("acme/li-outreach"))).toMatchObject({ proposed: "Linkedin Agent", source: "guess" });
    expect(reviewProductName("台灣包車旅遊・機場接送｜RelayGo 專業包車平台", gh("acme/relaygo"))).toMatchObject({ proposed: "RelayGo", source: "guess" });
    expect(reviewProductName("Two Prices for the Same Model and How I Built Claude Burst", gh("acme/claude-burst")))
      .toMatchObject({ proposed: "Claude Burst", source: "guess" });
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

  it("짐작한 제안도 원래 이름을 둔다 — 2026-10-09 백필 표본에서 틀린 것들", () => {
    // 40자 넘는 제목 속 저장소 이름 묶음: 저장소가 남의 서비스 이름을 땄다
    expect(normalizedProductName("Earn your first dollar online with Gumroad", gh("acme/gumroad"))).toBe("Earn your first dollar online with Gumroad");
    // 구분자 뒤 조각이 저장소 이름과 맞아도 앞쪽이 브랜드였다
    expect(normalizedProductName("MicroGains || Daily-habit-tracker", gh("acme/daily-habit-tracker"))).toBe("MicroGains || Daily-habit-tracker");
    // 짧은 낱말을 약어로 짐작했다('Haider ALI')
    expect(normalizedProductName("HAIDER ALI", gh("acme/portfolio"))).toBe("HAIDER ALI");
    // 이모지만 뗀 것은 그대로 고친다
    expect(normalizedProductName("🦎 Reptiles RPG", gh("acme/reptiles-rpg"))).toBe("Reptiles RPG");
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

/** 2026-10-11 공개분에서 찾은 오류 모양 — 자동으로 고치되, 틀린 이름을 만들지 않는다 */
describe("인사·문서 머리말과 README 첫 줄 (2026-10-11)", () => {
  const auto = (name: string, repo: string, readme?: string) => normalizedProductName(name, gh(repo), readme);

  it("문서 생성기의 기본 제목은 안의 이름을 그대로 쓴다", () => {
    expect(reviewProductName("Welcome to pytimer’s documentation!", gh("veltzer/pytimer"))).toMatchObject({ issues: ["boilerplate"], proposed: "pytimer", source: "title" });
    expect(auto("Welcome to TensorRT LLM’s Documentation!", "NVIDIA/TensorRT-LLM")).toBe("TensorRT LLM");
    expect(auto("Welcome to the Kitsu Developer Documentation!", "cgwire/kitsu")).toBe("Kitsu");
    // 이름 없는 문서 제목은 고칠 이름이 없다
    expect(auto("Welcome to the documentation", "acme/handbook")).toBe("Welcome to the documentation");
  });

  it("Welcome to·About 은 남는 말이 저장소와 이어질 때만 뗀다", () => {
    expect(auto("Welcome to Workrave", "rcaelers/workrave")).toBe("Workrave");
    expect(auto("About OSDCloud | OSDCloud by Recast", "RecastSoftware/RecastOSDCloud")).toBe("OSDCloud");
    expect(auto("Welcome to the Apache Struts project", "apache/struts")).toBe("Apache Struts");
    // 저장소와 이어지지 않으면 짐작 — 자동으로 쓰지 않는다
    expect(reviewProductName("Welcome to my portfolio site", gh("jdoe/jdoe.dev"))).toMatchObject({ source: "guess" });
    expect(auto("Welcome to my portfolio site", "jdoe/jdoe.dev")).toBe("Welcome to my portfolio site");
    // 제목 전체가 저장소 이름이면 진짜 이름이다
    expect(auto("About Time", "acme/about-time")).toBe("About Time");
  });

  it("뒤 꾸밈말(demo·docs·playground·文档)은 남는 이름이 저장소 이름과 같을 때만 뗀다", () => {
    expect(auto("Lab Tracker Demo", "SamuelBrudner/lab-tracker")).toBe("Lab Tracker");
    expect(auto("AgentRouter 文档", "acme/agentrouter")).toBe("AgentRouter");
    expect(auto("fast-check official documentation", "dubzzz/fast-check")).toBe("fast-check");
    expect(auto("MUI / Playground", "acme/mui")).toBe("MUI");
    expect(auto("@fnix/lexxy-mathjax demo", "fnix/lexxy-mathjax")).toBe("@fnix/lexxy-mathjax");
    // 2026-10-11 미리보기에서 틀렸던 것들 — 그대로 둔다
    expect(auto("Lawson's Learning Playground", "MrGamble01/lawson")).toBe("Lawson's Learning Playground");
    expect(auto("Modelica by Example", "mtiller/ModelicaByExample")).toBe("Modelica by Example");
    expect(auto(".NET documentation", "dotnet/runtime")).toBe(".NET documentation");
    // 저장소 이름에도 꾸밈말이 있으면 이름의 일부다
    expect(auto("NVIDIA NemoClaw Community Examples", "NVIDIA/nemoclaw-community-examples")).toBe("NVIDIA NemoClaw Community Examples");
  });

  it("@storybook/… 제목은 이름이 아니다 — README 첫 줄이 저장소 이름과 같으면 그 표기로", () => {
    expect(reviewProductName("@storybook/core", gh("adobe/react-spectrum-charts"), "React Spectrum Charts\n\nDocumentation\n"))
      .toMatchObject({ issues: ["generic"], proposed: "React Spectrum Charts", source: "readme" });
    // README 가 없으면 저장소 이름 제안 — 사람이 본다
    expect(reviewProductName("@storybook/core", gh("cosmosgl/graph"))).toMatchObject({ issues: ["generic"], source: "repo" });
    expect(auto("@storybook/core", "cosmosgl/graph")).toBe("@storybook/core");
  });

  it("README 첫 줄은 저장소(또는 owner) 이름과 같을 때만, 템플릿·흔한 배포 이름·주소는 쓰지 않는다", () => {
    expect(auto("Welcome back", "kendrick-na/findable", "Findable — 한국 최초 Agentic GEO Platform\n\n**AI 답변…**")).toBe("Findable");
    expect(auto("Home Page", "kadakareer/product", "Kadakareer — Product\n\nProduct management workspace")).toBe("Kadakareer");
    // 템플릿 README
    expect(auto("Welcome back", "SamIrving94/Bellwood-Lane-Ventures", "next-forge\n\n**Production-grade Turborepo template**")).toBe("Welcome back");
    // 저장소와 이어지기만 하는 첫 줄
    expect(auto("Home", "acme/scanx", "ScanX: Scan Smarter. Understand Better.")).toBe("Home");
    // 흔한 배포 이름
    expect(auto("Accueil", "jdoe/portfolio-v1", "Portfolio v1\n")).toBe("Accueil");
    // 주소만 든 첫 줄
    expect(auto("Home Page", "opendatahub-io/opendatahub-operator", "(https://codecov.io/github/opendatahub-io/opendatahub-operator)\n")).toBe("Home Page");
    // 슬로건 제목은 README 로 대신하지 않는다
    expect(reviewProductName("Flexible Open-Source ERP & CRM for SMBs", gh("acme/mycompany"), "MyCompany\n")).toMatchObject({ source: "repo" });
  });
});

/** 2026-10-11 백필 계획에서 기존 규칙이 틀린 넷 — 자동으로 고치지 않는다 */
describe("구분자·콜론 앞쪽이 저장소와 흔한 낱말 하나로만 이어질 때 (2026-10-11)", () => {
  it("앞뒤가 다 이어지면 짐작이다", () => {
    expect(reviewProductName("CRM • André Vitor Fotografia", gh("contatoandevitorfotografia-hue/crm-andre-vitor"))).toMatchObject({ source: "guess" });
    expect(normalizedProductName("Travel Blog & Travel Guides • Daniela and Will Travel", gh("Daniela-and-Will-Travel/daniela-and-will-travel.github.io")))
      .toBe("Travel Blog & Travel Guides • Daniela and Will Travel");
  });

  it("콜론은 앞쪽이 저장소 이름을 품을 때만 자른다 — owner·흔한 낱말로는 자르지 않는다", () => {
    expect(normalizedProductName("firstworks: SQL Relay", gh("firstworks-software/sqlrelay"))).toBe("firstworks: SQL Relay");
    expect(normalizedProductName("Open source: IPCamLapse and OpenCamInterop", gh("KalyteraSystems/OpenCamInterop"))).toBe("Open source: IPCamLapse and OpenCamInterop");
    expect(normalizedProductName("AppFlowy: Open Source Notion Alternative", gh("AppFlowy-IO/AppFlowy"))).toBe("AppFlowy");
  });
});

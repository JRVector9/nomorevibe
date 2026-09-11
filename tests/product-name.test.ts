import { describe, expect, it } from "vitest";
import { isGenericTitle, productName } from "@/lib/crawl/product-name";

// 모두 2026-09-11 프로드에 공개된 이름이다 — 레포와 주소도 실제 값이다
describe("productName — 제목에서 이름만 남긴다", () => {
  it("공백이 있는 구분자에서 앞쪽을 쓴다", () => {
    expect(productName("RevealUI | Build it once. Every product after starts ahead.", "someone/reveal")).toBe("RevealUI");
    expect(productName("tailr - A blazing-fast log tail & search server", "acme/tailr")).toBe("tailr");
    expect(productName("fspec ~ Stop fixing AI chaos. Start shipping quality.", "acme/fspec")).toBe("fspec");
    expect(productName("Steam Community :: Steam Workshop", "acme/mod")).toBe("Steam Community");
    // 이름 안의 하이픈은 자르지 않는다
    expect(productName("e-commerce-kit", "someone/shop")).toBe("e-commerce-kit");
  });

  it("붙여 쓴 구분자는 앞쪽이 레포 이름과 맞을 때만 자른다", () => {
    expect(productName("Radiant: your whole coding stack, in one window", "acme/radiant")).toBe("Radiant");
    expect(productName("kanso—the language where the source contains only decisions", "acme/kanso")).toBe("kanso");
    expect(productName("AlgoChat. Cross-language E2EE messaging protocol", "acme/protocol-algochat")).toBe("AlgoChat");
    expect(productName("WPPilot: AI Control for WordPress and Elementor", "acme/wordpress-mcp-elementor-wppilot")).toBe("WPPilot");
    expect(productName("Telegram Claude + Codex: Remote Coding Agents via Telegram", "acme/telegram-claude-codex")).toBe("Telegram Claude + Codex");
    // 맞지 않으면 콜론이 이름의 일부일 수 있어 그대로 둔다
    expect(productName("Multi-Agent AI Governance: lessen uit 2.472 dispatches", "acme/vnx-orchestration"))
      .toBe("Multi-Agent AI Governance: lessen uit 2.472 dispatches");
  });

  it("주소와 맞아도 자른다 — 레포 이름이 제품 이름과 다를 때가 많다", () => {
    expect(productName("LaTeX.to: Free LaTeX to PDF and Image Converter, Online LaTeX Editor", "acme/skills", "https://latex.to")).toBe("LaTeX.to");
    expect(productName("Revyy: Practice Quizzes & Mock Exams From Your Own Notes", "acme/revvy", "https://revyy-psi.vercel.app")).toBe("Revyy");
    expect(productName("Formoria：台灣品牌探索與選物平台", "acme/web", "https://formoria.tw")).toBe("Formoria");
  });

  it("쉼표는 목록일 수 있어 레포·주소와 같을 때만 자른다", () => {
    expect(productName("Appstrate, the open‑source agent runtime platform", "acme/appstrate")).toBe("Appstrate");
    expect(productName("AuraMux, the macOS terminal I built", "rmehdee/auramux-releases")).toBe("AuraMux");
    expect(productName("Xbox, PS5, Steam & Apple TV Remote Mapper for macOS", "acme/xbox-remote-mapper"))
      .toBe("Xbox, PS5, Steam & Apple TV Remote Mapper for macOS");
    expect(productName("Sri Parvathi Jadala Ramalingeshwara Swamy Devasthanam, Cheruvugattu", "acme/spjrsd"))
      .toBe("Sri Parvathi Jadala Ramalingeshwara Swamy Devasthanam, Cheruvugattu");
  });

  it("이니셜의 마침표는 구분자가 아니다", () => {
    expect(productName("Glen E. Grant", "glen/glenegrant")).toBe("Glen E. Grant");
  });

  it("짧은 앞쪽은 그대로 이름이다 — 레포 이름만큼 줄이지 않는다", () => {
    expect(productName("Asterwise MCP Server: Real Astrology, Numerology & Tarot for AI", "acme/asterwise-mcp")).toBe("Asterwise MCP Server");
    expect(productName("Mend Renovate: Automated Dependency Updates", "renovatebot/renovate")).toBe("Mend Renovate");
  });

  it("문장이면 그 안의 레포 이름만 쓴다", () => {
    expect(productName("Two Prices for the Same Model: Building Claude Burst", "acme/claude-burst")).toBe("Claude Burst");
    expect(productName("Your agents forget. Neotoma makes them remember.", "acme/neotoma")).toBe("Neotoma");
    expect(productName("Как я собрал WebDev Agent Kit, чтобы нейронка не переписывала код", "acme/webdev-agent-kit")).toBe("WebDev Agent Kit");
    // 레포 이름이 없으면 문장을 그대로 둔다 — 지어내지 않는다
    expect(productName("Preserving Long-Tailed Expert Information in Mixture-of-Experts Tuning", "acme/ExpertCondenser"))
      .toBe("Preserving Long-Tailed Expert Information in Mixture-of-Experts Tuning");
  });

  it("이름이 아닌 제목은 레포 이름으로 바꾼다", () => {
    expect(productName("Home", "acme/nemovia")).toBe("nemovia");
    expect(productName("Sign in", "acme/tradeflow-wms")).toBe("tradeflow-wms");
    expect(productName("", "acme/mystery")).toBe("mystery");
    // 앞쪽이 그런 제목이면 레포와 맞는 뒤쪽을 쓴다
    expect(productName("Sign in | TradeFlow WMS", "acme/tradeflow-wms")).toBe("TradeFlow WMS");
    // 주소 첫 마디와 일부만 맞는 뒤쪽은 쓰지 않는다
    expect(productName("Sign in - Google Accounts", "acme/cv-insight", "https://accounts.google.com/x")).toBe("cv-insight");
    // 레포 이름도 흔한 것이면 제목을 그대로 둔다
    expect(productName("Home", "acme/frontend")).toBe("Home");
  });

  it("앞쪽이 제대로 된 말이면 주소와 맞는 뒤쪽을 고르지 않는다", () => {
    expect(productName("Amazon Bedrock - AWS", "acme/bedrock-demo", "https://aws.amazon.com/bedrock")).toBe("Amazon Bedrock");
  });

  it("실체 참조를 되돌린다", () => {
    expect(productName("WrzDJ &mdash; Real-Time Song Requests for DJs", "acme/wrzdj")).toBe("WrzDJ");
    expect(productName("MITRE ATT&CK&reg;", "acme/mitre")).toBe("MITRE ATT&CK®");
  });

  it("isGenericTitle 은 대소문자와 앞뒤 공백을 가리지 않는다", () => {
    expect(isGenericTitle(" Sign In ")).toBe(true);
    expect(isGenericTitle("Homey")).toBe(false);
  });
});

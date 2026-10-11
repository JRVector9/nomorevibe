import { describe, expect, it } from "vitest";
import { checkKoreanTagline, leadClause } from "@/lib/domain/products/korean-tagline";
import { taglineSource } from "@/lib/jobs/products/korean-tagline";

// 2026-10-11 지금 뜨는 상위에서 '너무 긺'으로 네 번 버려져 원문으로 남은 두 소개(운영 DB 그대로)
const SHELLRS = "ShellRS is a free, open-source SSH client written in Rust: host management, terminals, WinSCP-style SFTP and port forwarding in one GPU-rendered window, for macOS, Windows and Linux.";
const OPUSCAR = "43 film styles, each a reusable style prompt plus a short film made entirely in code by Claude Opus 5.5. Pick a style, bring your own story, and let your agent direct. | Opus5.5 x 43 种影片风格：风格提示词 + 纯代码";

describe("leadClause — 긴 소개의 앞 문장", () => {
  it("처음 끝나는 문장·구절까지 자른다", () => {
    expect(leadClause(SHELLRS)).toBe("ShellRS is a free, open-source SSH client written in Rust");
    // 5.5 의 소수점은 문장 끝이 아니다
    expect(leadClause(OPUSCAR)).toBe("43 film styles, each a reusable style prompt plus a short film made entirely in code by Claude Opus 5.5");
    expect(leadClause("Run Claude Haiku, Sonnet and Opus in your Chrome side panel — it reads and acts on the page")).toBe("Run Claude Haiku, Sonnet and Opus in your Chrome side panel");
    expect(leadClause("为了 OI 比赛而生的基于 Lemon + LemonPlus 的轻量评测系统 | 三大桌面系统支持")).toBe("为了 OI 比赛而生的基于 Lemon + LemonPlus 的轻量评测系统");
  });

  it("이름뿐인 짧은 머리는 건너뛰고, 끊을 자리가 없거나 너무 뒤에 있으면 원문 그대로다", () => {
    expect(leadClause("Notely: a note-taking app for students. Sync across devices and share with classmates"))
      .toBe("Notely: a note-taking app for students");
    expect(leadClause("  Merge PDF files in the browser  ")).toBe("Merge PDF files in the browser");
    const noBreak = `${"word ".repeat(30).trim()}. Then more`;
    expect(leadClause(noBreak)).toBe(noBreak);
  });

  it("앞 문장을 원문으로 삼아도 검사는 그대로 건다 — 앞 문장에 없는 말은 지어낸 것이다", () => {
    const source = { name: "ShellRS", tagline: leadClause(SHELLRS) };
    expect(checkKoreanTagline("Rust로 만든 무료 오픈소스 SSH 클라이언트 ShellRS", source).ok).toBe(true);
    // 잘라 낸 뒷부분의 SFTP 를 붙이면 앞 문장에는 없는 낱말이다
    expect(checkKoreanTagline("Rust로 만든 무료 SSH·SFTP 클라이언트 ShellRS", source)).toEqual({ ok: false, reason: "invented_term" });
  });
});

describe("taglineSource — 모델에 보낼 소개", () => {
  const task = (lastError: string | null | undefined, tagline = SHELLRS) => ({ productId: 1, name: "ShellRS", tagline, repoUrl: null, attempts: 1, lastError });

  it("처음이거나 다른 이유로 버려졌으면 지금 소개 그대로 보낸다", () => {
    expect(taglineSource(task(undefined))).toBe(SHELLRS);
    expect(taglineSource(task(null))).toBe(SHELLRS);
    expect(taglineSource(task("rejected:name_lost"))).toBe(SHELLRS);
    expect(taglineSource(task("http_502"))).toBe(SHELLRS);
  });

  it("'너무 긺'·'빈 줄'로 버려졌으면 앞 문장만 보낸다", () => {
    expect(taglineSource(task("rejected:too_long"))).toBe("ShellRS is a free, open-source SSH client written in Rust");
    expect(taglineSource(task("rejected:empty", OPUSCAR))).toBe(leadClause(OPUSCAR));
  });
});

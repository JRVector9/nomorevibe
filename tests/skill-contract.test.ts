import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET as serveSkill } from "@/app/skill.md/route";
import { GET as serveInstaller } from "@/app/install.sh/route";

const skill = () => readFileSync("skill/SKILL.md", "utf8");

describe("distributed /nomorevibe evidence skill", () => {
  it("routes every evidence command without breaking registration, verification, or deletion", () => {
    const source = skill();
    for (const command of ["profile", "links", "media", "provenance", "update", "refresh", "verify", "delete"]) {
      expect(source, command).toContain(`\`${command}\``);
    }
    expect(source).toContain("인자 없음 또는 URL");
    expect(source).toContain("등록/업데이트");
  });

  it("requires a preview and explicit confirmation before every maker write", () => {
    const source = skill();
    expect(source).toContain("쓰기 전 공통 절차");
    expect(source).toContain("현재 저장된 리소스를 GET");
    expect(source).toContain("ETag");
    expect(source).toContain("If-Match");
    expect(source).toContain("412");
    expect(source).toContain("삭제될 항목");
    expect(source).toContain("제안 payload");
    expect(source).toContain("명시적으로 확인");
    for (const command of ["profile", "links", "media", "provenance", "update"]) {
      expect(source, command).toMatch(new RegExp(`\\b${command}\\b[\\s\\S]*확인`));
    }
  });

  it("keeps edit tokens only in the credential store and out of project files", () => {
    const source = skill();
    expect(source).toContain("~/.config/nomorevibe/credentials.json");
    expect(source).toContain('{ "<api-origin>": { "<slug>": { "token": "<edit_token>" } } }');
    expect(source).toContain("API origin과 slug의 조합");
    expect(source).toContain("두 origin의 같은 slug가 서로 덮어쓰지 않게");
    expect(source).toContain("인증 요청 목적지는 일치한 credential의 origin만");
    expect(source).toContain("문자열 형식의 기존 credential");
    expect(source).toContain("수정 키를 보내지 않는다");
    expect(source).toContain("chmod 600");
    expect(source).toContain("X-Edit-Token");
    expect(source).toMatch(/수정 키[^\n]*\.nomorevibe\.json[^\n]*(?:저장|기록)[^\n]*않/);
    expect(source).toMatch(/수정 키[^\n]*프로젝트 파일[^\n]*(?:저장|기록)[^\n]*않/);
  });

  it("makes provenance opt-in, maker-reported, and metadata-only", () => {
    const source = skill();
    expect(source).toContain("명시적 동의(옵트인)");
    expect(source).toContain("maker_reported");
    for (const allowed of ["client", "model", "roles", "namespace", "name", "version", "hash", "commit"]) {
      expect(source, allowed).toContain(allowed);
    }
    for (const forbidden of ["스킬 지침 본문", "프롬프트", "대화 로그", "환경변수 값", "비밀값"]) {
      expect(source, forbidden).toContain(forbidden);
    }
  });

  it("matches the strict maker profile payload when a license is disclosed", () => {
    const source = skill();
    expect(source).toContain('"makerLicense"');
    expect(source).toContain('"spdxId"');
    expect(source).toContain('"url"');
  });

  it("submits at most eight image declarations and reports refresh as queued only", () => {
    const source = skill();
    expect(source).toContain("최대 8개");
    expect(source).toContain("altText");
    expect(source).toContain("외부 이미지 URL");
    expect(source).toContain("base64");
    expect(source).toContain("서버 작업이 나중에 내부 저장소로 복사");
    expect(source).toContain("수집 요청이 대기열에 등록");
    expect(source).toContain("갱신이 완료됐다고 말하지 않는다");
    expect(source).toContain("제공자 자격 증명");
  });

  it("submits repository declarations only when the host is supported", () => {
    const source = skill();
    expect(source).toContain("GitHub(`github.com`) 저장소만");
    expect(source).toContain("GitLab");
    expect(source).toContain("제안하지 않는다");
  });

  it("serves the same skill with an origin replacement and an installable shell script", async () => {
    const skillResponse = await serveSkill(new Request("https://registry.example/skill.md"));
    const body = await skillResponse.text();
    expect(skillResponse.headers.get("content-type")).toContain("text/markdown");
    expect(body).toContain("https://registry.example");
    expect(body).not.toContain("{{SITE_URL}}");

    const installerResponse = await serveInstaller(new Request("https://registry.example/install.sh"));
    const installer = await installerResponse.text();
    expect(installerResponse.headers.get("content-type")).toContain("text/x-shellscript");
    expect(installer).toContain("#!/bin/sh");
    expect(installer).toContain('curl -fsSL "$SITE/skill.md"');
    expect(installer).toContain("$HOME/.claude/skills/nomorevibe");
    expect(installer).toContain("$HOME/.codex/prompts");
  });
});

import { describe, expect, it } from "vitest";
import { GET as serveInstaller } from "@/app/install.sh/route";
import { metadata as launchMetadata } from "@/app/launch/page";
import { BRAND } from "@/lib/copy/brand";
import { verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { claimInviteUrl } from "@/lib/domain/products/claim-invite";
import { LAUNCH_COMMAND, VERIFY_COMMAND, installCommand, installScript } from "@/lib/domain/products/launch-command";

/** 등록 흐름이 밖으로 내보내는 글자 — 브랜드는 'nomorevibe' 하나, 명령 표기도 하나(UX-14·20·39) */
describe("등록 명령 표기", () => {
  it("홈·/launch·스크립트가 같은 명령을 쓴다", () => {
    expect(LAUNCH_COMMAND).toBe("/nomorevibe");
    expect(VERIFY_COMMAND).toBe("/nomorevibe verify");
    expect(installCommand("https://registry.example")).toBe("curl -fsSL https://registry.example/install.sh | sh");
  });

  it("/launch 제목은 한국어 조각과 브랜드", () => {
    expect(launchMetadata.title).toBe("프로젝트 공개하기 — nomorevibe");
  });
});

describe("install.sh", () => {
  it("브랜드 표기·설치 명령·다음 명령이 공용 값에서 나온다", async () => {
    const script = await (await serveInstaller(new Request("https://registry.example/install.sh"))).text();

    expect(script).toBe(installScript("https://registry.example"));
    expect(script).toContain(`# ${BRAND} 스킬 설치 스크립트`);
    expect(script).toContain(`# 사용: ${installCommand("https://registry.example")}`);
    expect(script).toContain(`echo "${BRAND} 스킬을 설치합니다..."`);
    expect(script).toContain(`이제 프로젝트 폴더에서 ${LAUNCH_COMMAND} 를 실행하세요.`);
    expect(script).not.toContain("NoMoreVibe");
  });
});

describe("README 배지", () => {
  it("글자만 브랜드로 바꾸고 크기는 그대로 둔다 — 남의 README 에 이미 박혀 있다", () => {
    const svg = verifiedBadgeSvg();
    expect(svg).toContain('width="156" height="20"');
    expect(svg).toContain(`>${BRAND}</text>`);
    expect(svg).toContain(`aria-label="Verified on ${BRAND}"`);
    expect(svg).not.toContain("NoMoreVibe");
  });
});

describe("클레임 초대", () => {
  it("제목·본문이 브랜드 표기와 공용 명령을 쓴다", () => {
    const url = claimInviteUrl(
      { name: "FoundApp", slug: "found-app", repoUrl: "https://github.com/a/found-app", source: "crawler", claimedAt: null },
      "https://registry.example",
    )!;
    const params = new URL(url).searchParams;
    expect(params.get("title")).toBe(`FoundApp is listed on ${BRAND} — claim or remove it`);
    expect(params.get("body")).toContain(`\`${installCommand("https://registry.example")}\``);
    expect(params.get("body")).toContain(`\`${LAUNCH_COMMAND}\` in Claude Code or Codex`);
    expect(`${params.get("title")}${params.get("body")}`).not.toContain("NoMoreVibe");
  });
});

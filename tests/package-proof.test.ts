import { describe, expect, it, vi } from "vitest";
import { contentFiles, contentProof, mergeProof, packageProofOf, pathProof, PACKAGE_PROOF_KEY } from "@/lib/crawl/package-proof";
import { probePackageManifests } from "@/lib/crawl/package-probe";
import { judge, accessFromDocument, factsFromRepoMeta, type RepoFacts } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { lacksDeployment, productAccess } from "@/lib/domain/products/access";

const ok = <T,>(value: T) => ({ ok: true as const, status: 200 as const, value, etag: null, lastModified: null, link: null });
const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("패키지 증거 — 경로와 내용", () => {
  it("SKILL.md·Claude 플러그인·JetBrains plugin.xml 은 경로로 가르고, 남의 코드 안의 것은 세지 않는다", () => {
    expect(pathProof(["README.md", "skills/review/SKILL.md", ".claude-plugin/plugin.json", "src/main/resources/META-INF/plugin.xml"]))
      .toEqual([{ kind: "skill", path: "skills/review/SKILL.md" }, { kind: "claude-plugin", path: ".claude-plugin/plugin.json" },
        { kind: "jetbrains-plugin", path: "src/main/resources/META-INF/plugin.xml" }]);
    expect(pathProof(["node_modules/x/SKILL.md", "vendor/y/.claude-plugin/plugin.json", "docs/skill.md"])).toEqual([]);
  });

  it("저장소 개발용(.agents·.claude·.cursor)과 예시·문서·테스트 아래의 SKILL.md 는 제품 증거가 아니다", () => {
    for (const path of [".agents/skills/dev/SKILL.md", ".claude/skills/review/SKILL.md", "home/.agents/skills/b/SKILL.md",
      "docs/skills/x/SKILL.md", "examples/skill/SKILL.md", "internal/gaggles/example/skills/implement/SKILL.md", "tests/fixtures/SKILL.md"]) {
      expect(pathProof([path])).toEqual([]);
    }
    // 내놓는 스킬 — 루트, skills/ 아래, 플러그인 묶음 아래
    for (const path of ["SKILL.md", "skills/pdf/SKILL.md", "plugins/review/skills/lint/SKILL.md"]) {
      expect(pathProof([path])).toEqual([{ kind: "skill", path }]);
    }
    // 이미 저장된 옛 증거도 지금 기준으로 다시 거른다
    expect(packageProofOf({ [PACKAGE_PROOF_KEY]: [{ kind: "skill", path: ".agents/skills/dev/SKILL.md" }, { kind: "mcp-server", path: "package.json" }] }))
      .toEqual([{ kind: "mcp-server", path: "package.json" }]);
  });

  it("내용은 루트 것부터 세 개까지, 큰 파일과 남의 코드는 읽지 않는다", () => {
    expect(contentFiles([{ path: "extension/manifest.json", size: 900 }, { path: "package.json", size: 800 },
      { path: "node_modules/a/package.json", size: 10 }, { path: "pyproject.toml", size: 999_999 }, { path: "server.json", size: 10 }]))
      .toEqual(["package.json", "server.json", "extension/manifest.json"]);
  });

  it("package.json·manifest.json·pyproject·server.json 에서 MCP·확장을 알아본다", () => {
    expect(contentProof("package.json", JSON.stringify({ bin: { "pdf-mcp": "dist/index.js" }, dependencies: { "@modelcontextprotocol/sdk": "^1" } }))).toEqual(["mcp-server"]);
    // 실행 진입점이 없으면 MCP 를 쓰는 라이브러리·SDK 일 뿐이다
    expect(contentProof("package.json", JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "^1" } }))).toEqual([]);
    expect(contentProof("pyproject.toml", 'dependencies = ["mcp>=1.2"]')).toEqual([]);
    expect(contentProof("package.json", JSON.stringify({ engines: { vscode: "^1.90.0" }, devDependencies: { "@raycast/api": "1" } })))
      .toEqual(["vscode-extension", "raycast-extension"]);
    expect(contentProof("src/manifest.json", JSON.stringify({ manifest_version: 3, name: "Tab saver" }))).toEqual(["browser-extension"]);
    expect(contentProof("manifest.json", JSON.stringify({ id: "daily-notes", minAppVersion: "1.4.0" }))).toEqual(["obsidian-plugin"]);
    expect(contentProof("pyproject.toml", 'dependencies = ["mcp[cli]>=1.2", "httpx"]\n\n[project.scripts]\npdf-mcp = "pdf_mcp:main"')).toEqual(["mcp-server"]);
    expect(contentProof("server.json", JSON.stringify({ $schema: "https://static.modelcontextprotocol.io/schemas/server.schema.json" }))).toEqual(["mcp-server"]);
    // 웹앱 manifest·평범한 패키지·깨진 JSON 은 아니다
    expect(contentProof("public/manifest.json", JSON.stringify({ name: "PWA", start_url: "/" }))).toEqual([]);
    expect(contentProof("package.json", JSON.stringify({ dependencies: { react: "19" } }))).toEqual([]);
    expect(contentProof("package.json", "{not json")).toEqual([]);
    expect(contentProof("pyproject.toml", 'dependencies = ["mcpx-utils"]')).toEqual([]);
  });

  it("저장된 증거는 아는 종류만 읽고, 종류마다 하나만 남긴다", () => {
    expect(packageProofOf({ [PACKAGE_PROOF_KEY]: [{ kind: "skill", path: "SKILL.md" }, { kind: "virus", path: "x" }, "bad"] }))
      .toEqual([{ kind: "skill", path: "SKILL.md" }]);
    expect(packageProofOf({})).toEqual([]);
    expect(packageProofOf(null)).toEqual([]);
    expect(mergeProof([{ kind: "skill", path: "a/SKILL.md" }], [{ kind: "skill", path: "b/SKILL.md" }, { kind: "mcp-server", path: "package.json" }]))
      .toEqual([{ kind: "skill", path: "a/SKILL.md" }, { kind: "mcp-server", path: "package.json" }]);
  });
});

describe("패키지 증거 — GitHub 에서 찾기", () => {
  it("파일 목록 한 번과 manifest 내용으로 증거를 모은다", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("/git/trees/")) return ok({ truncated: false, tree: [
        { path: "skills", type: "tree" }, { path: "skills/pdf/SKILL.md", type: "blob", size: 400 },
        { path: "package.json", type: "blob", size: 300 }] });
      return ok({ encoding: "base64", content: base64(JSON.stringify({ bin: "dist/index.js", dependencies: { "@modelcontextprotocol/sdk": "1" } })) });
    });
    const probe = await probePackageManifests("maker/tools", "main", request as never);
    expect(probe).toEqual({ ok: true, truncated: false, proof: [{ kind: "skill", path: "skills/pdf/SKILL.md" }, { kind: "mcp-server", path: "package.json" }] });
    expect(request).toHaveBeenCalledWith("/repos/maker/tools/git/trees/main?recursive=1");
    expect(request).toHaveBeenCalledWith("/repos/maker/tools/contents/package.json?ref=main");
  });

  it("한도에 걸리면 그대로 알리고, 사라진 파일은 건너뛴다", async () => {
    const limited = vi.fn(async () => ({ ok: false as const, error: { kind: "rate_limited" as const, resetAt: null } }));
    expect(await probePackageManifests("maker/tools", "main", limited as never)).toEqual({ ok: false, error: { kind: "rate_limited", resetAt: null } });
    const gone = vi.fn(async (path: string) => path.includes("/git/trees/")
      ? ok({ tree: [{ path: "package.json", type: "blob", size: 10 }] })
      : { ok: false as const, error: { kind: "not_found" as const } });
    expect(await probePackageManifests("maker/tools", "main", gone as never)).toEqual({ ok: true, truncated: false, proof: [] });
  });
});

describe("패키지 증거 — 판정", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const repo: RepoFacts = { repo: "maker/pdf-skill", stars: 12, isFork: false, archived: false, ownerType: "User", pushedAt: now,
    description: "Claude skill that fills PDF forms", packageProof: [{ kind: "skill", path: "SKILL.md" }] };
  const missing = { productUrl: null, status: null };

  it("배포 주소가 없어도 증거가 있고 5스타 이상이면 설치형 심사로 넘긴다", () => {
    expect(judge(repo, missing, DEFAULT_CRAWL_SETTINGS, now)).toMatchObject({
      state: "needs_review", reason: "ambiguous", cause: "installable_product",
      signals: { accessMode: "installable", packageProof: [{ kind: "skill", path: "SKILL.md" }] },
    });
    expect(judge(repo, missing, DEFAULT_CRAWL_SETTINGS, now).trace.at(-2)).toMatchObject({ rule: "패키지 증거", passed: true });
  });

  it("증거가 없거나 5스타 미만이면 예전처럼 배포 주소 없음으로 거절한다", () => {
    expect(judge({ ...repo, packageProof: [] }, missing, DEFAULT_CRAWL_SETTINGS, now).reason).toBe("no_homepage");
    expect(judge({ ...repo, stars: 4 }, missing, DEFAULT_CRAWL_SETTINGS, now).reason).toBe("no_homepage");
  });

  it("포크·보관된 것은 증거가 있어도 받지 않고, 진짜 사이트가 있으면 웹사이트로 본다", () => {
    expect(judge({ ...repo, isFork: true }, missing, DEFAULT_CRAWL_SETTINGS, now).reason).toBe("fork");
    expect(judge({ ...repo, archived: true }, missing, DEFAULT_CRAWL_SETTINGS, now).state).toBe("rejected");
    expect(productAccess({ repo: repo.repo, stars: 12, productUrl: "https://pdf-skill.app", packageProof: repo.packageProof }))
      .toEqual({ mode: "website", url: "https://pdf-skill.app" });
  });

  it("저장된 원본에서 같은 입구를 계산한다 — 심사 입력·발행이 같은 답을 본다", () => {
    const repoMeta = { stargazers_count: 12, [PACKAGE_PROOF_KEY]: [{ kind: "skill", path: "SKILL.md" }] };
    expect(factsFromRepoMeta("maker/pdf-skill", repoMeta).packageProof).toEqual([{ kind: "skill", path: "SKILL.md" }]);
    expect(accessFromDocument({ repo: "maker/pdf-skill", repoMeta, productUrl: null, pageStatus: null, pageMeta: null }, DEFAULT_CRAWL_SETTINGS))
      .toEqual({ mode: "installable", url: "https://github.com/maker/pdf-skill" });
  });

  it("배포 주소 없음은 비었거나 자기 저장소·문서 주소일 때다", () => {
    expect(lacksDeployment("maker/pdf-skill", null)).toBe(true);
    expect(lacksDeployment("maker/pdf-skill", "https://github.com/Maker/pdf-skill/")).toBe(true);
    expect(lacksDeployment("maker/pdf-skill", "https://docs.pdf-skill.dev")).toBe(true);
    expect(lacksDeployment("maker/pdf-skill", "https://github.com/someone/else")).toBe(false);
    expect(lacksDeployment("maker/pdf-skill", "https://pdf-skill.app")).toBe(false);
  });
});

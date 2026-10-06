/**
 * 패키지 증거 — 사이트가 없어도 설치해 쓰는 소프트웨어라는 것을 저장소 안의 파일로 보인 것(2026-10-06, 사용자 결정).
 *
 * 스타 500개 미만이고 배포 주소가 없는 저장소는 "배포 URL 없음"으로 바로 거절했다. 그런데 스킬·플러그인·MCP 서버·
 * 확장은 원래 사이트가 없다 — 30일에 스타 5개 이상인 그런 거절이 5,831건이었다. 저장소에 그 생태계가 요구하는
 * 파일(SKILL.md, 플러그인 manifest 등)이 있으면 설치형 후보로 넘기고, 소프트웨어인지는 1차·2차가 README 로 가른다.
 * 파일이 있다는 것만으로 승인하지 않는다 — 스킬을 만드는 도구나 프롬프트 모음은 심사가 거른다.
 *
 * 증거는 수집 때 GitHub 응답(repoMeta)의 PACKAGE_PROOF_KEY 에 붙여 둔다. 레포의 사실이라 레포 메타와 함께 바뀐다.
 */

export const PACKAGE_PROOF_KEY = "nmv_package_proof";
export const PACKAGE_KINDS = ["skill", "claude-plugin", "mcp-server", "vscode-extension", "browser-extension",
  "obsidian-plugin", "jetbrains-plugin", "raycast-extension"] as const;
export type PackageKind = typeof PACKAGE_KINDS[number];
export type PackageProof = { kind: PackageKind; path: string }[];

/** 남의 코드를 담아 둔 곳 — 거기 있는 SKILL.md·manifest 는 이 저장소의 것이 아니다 */
const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.git)\//;

/** 경로만으로 가르는 것 */
const PATH_RULES: { kind: PackageKind; pattern: RegExp }[] = [
  { kind: "skill", pattern: /(^|\/)SKILL\.md$/ },
  { kind: "claude-plugin", pattern: /^\.claude-plugin\/(plugin|marketplace)\.json$/ },
  { kind: "jetbrains-plugin", pattern: /(^|\/)src\/main\/resources\/META-INF\/plugin\.xml$/ },
];

/** 내용을 읽어야 가르는 파일 — 루트와 한 단계 아래의 manifest 만(확장은 src/·extension/ 아래에 두기도 한다) */
const CONTENT_FILES = [/^package\.json$/, /^pyproject\.toml$/, /^server\.json$/, /^([^/]+\/)?manifest\.json$/];
export const MAX_CONTENT_FILES = 3;
export const MAX_CONTENT_BYTES = 64 * 1024;

export function pathProof(paths: readonly string[]): PackageProof {
  const proof: PackageProof = [];
  for (const rule of PATH_RULES) {
    const path = paths.find((item) => !VENDORED.test(item) && rule.pattern.test(item));
    if (path) proof.push({ kind: rule.kind, path });
  }
  return proof;
}

/** 내용을 볼 파일 — 루트 것이 먼저다 */
export function contentFiles(files: readonly { path: string; size?: number }[]): string[] {
  return files.filter((file) => !VENDORED.test(file.path) && (file.size ?? 0) <= MAX_CONTENT_BYTES
      && CONTENT_FILES.some((pattern) => pattern.test(file.path)))
    .map((file) => file.path).sort((a, b) => a.split("/").length - b.split("/").length).slice(0, MAX_CONTENT_FILES);
}

/** 파일 하나의 내용이 어떤 패키지를 말하는지 */
export function contentProof(path: string, text: string): PackageKind[] {
  const name = path.split("/").at(-1);
  if (name === "pyproject.toml") return /["'](mcp|fastmcp)(\[[^\]]*\])?\s*([<>=~!]|["'])/.test(text) ? ["mcp-server"] : [];
  let json: unknown;
  try { json = JSON.parse(text); } catch { return []; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const value = json as Record<string, unknown>;
  if (name === "server.json") return typeof value.$schema === "string" && value.$schema.includes("modelcontextprotocol") ? ["mcp-server"] : [];
  if (name === "manifest.json") {
    if (typeof value.manifest_version === "number") return ["browser-extension"];
    // Obsidian 플러그인 manifest — id·이름·지원하는 앱 최소 버전
    if (typeof value.minAppVersion === "string" && typeof value.id === "string") return ["obsidian-plugin"];
    return [];
  }
  const dependencies = ["dependencies", "devDependencies", "peerDependencies"]
    .flatMap((key) => value[key] && typeof value[key] === "object" ? Object.keys(value[key] as object) : []);
  const kinds: PackageKind[] = [];
  if (dependencies.includes("@modelcontextprotocol/sdk") || dependencies.includes("fastmcp")) kinds.push("mcp-server");
  const engines = value.engines as Record<string, unknown> | undefined;
  if (typeof engines?.vscode === "string") kinds.push("vscode-extension");
  if (dependencies.includes("@raycast/api")) kinds.push("raycast-extension");
  return kinds;
}

/** 저장된 증거를 읽는다 — 모르는 종류·모양은 버린다 */
export function packageProofOf(meta: Record<string, unknown> | null | undefined): PackageProof {
  const raw = meta?.[PACKAGE_PROOF_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => item && typeof item === "object"
    && (PACKAGE_KINDS as readonly string[]).includes((item as { kind?: unknown }).kind as string)
    && typeof (item as { path?: unknown }).path === "string"
    ? [{ kind: (item as { kind: PackageKind }).kind, path: (item as { path: string }).path.slice(0, 300) }] : []).slice(0, PACKAGE_KINDS.length);
}

/** 종류마다 하나 — 처음 찾은 경로를 남긴다 */
export function mergeProof(...lists: PackageProof[]): PackageProof {
  const seen = new Map<PackageKind, string>();
  for (const item of lists.flat()) if (!seen.has(item.kind)) seen.set(item.kind, item.path);
  return [...seen].map(([kind, path]) => ({ kind, path }));
}

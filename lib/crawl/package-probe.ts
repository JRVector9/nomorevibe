import { githubRequest, type GitHubFailure } from "./github";
import { contentFiles, contentProof, mergeProof, pathProof, type PackageProof } from "./package-proof";

export type PackageProbe = { ok: true; proof: PackageProof; truncated: boolean } | { ok: false; error: GitHubFailure };

/**
 * 저장소 파일 목록에서 패키지 증거를 찾는다(package-proof.ts). 요청은 목록 한 번과 manifest 내용 최대 세 번이다.
 * 아주 큰 저장소는 GitHub 이 목록을 잘라 보낸다(truncated) — 찾은 것까지만 쓴다.
 */
export async function probePackageManifests(repo: string, branch: string,
  request: typeof githubRequest = githubRequest): Promise<PackageProbe> {
  const tree = await request<{ truncated?: boolean; tree?: { path?: unknown; type?: unknown; size?: unknown }[] }>(
    `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!tree.ok) return tree;
  if (tree.status !== 200 || !Array.isArray(tree.value.tree)) return { ok: true, proof: [], truncated: false };
  const blobs = tree.value.tree.flatMap((item) => item.type === "blob" && typeof item.path === "string"
    ? [{ path: item.path, size: typeof item.size === "number" ? item.size : undefined }] : []);
  const proof = pathProof(blobs.map((blob) => blob.path));
  for (const path of contentFiles(blobs)) {
    const file = await request<{ content?: unknown; encoding?: unknown }>(
      `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`);
    if (!file.ok) {
      // 목록에 있던 파일이 사라졌으면 넘어간다. 한도·인증 문제는 부른 쪽이 다시 시도한다
      if (file.error.kind === "not_found") continue;
      return file;
    }
    if (file.status !== 200 || file.value.encoding !== "base64" || typeof file.value.content !== "string") continue;
    const text = Buffer.from(file.value.content, "base64").toString("utf8");
    proof.push(...contentProof(path, text).map((kind) => ({ kind, path })));
  }
  return { ok: true, proof: mergeProof(proof), truncated: tree.value.truncated === true };
}

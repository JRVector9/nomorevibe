import { githubRequest, type GitHubFailure } from "./github";
import { AGENT_DIRECTORY_PREFIXES, matchAgentArtifact } from "@/lib/domain/evidence/agents/catalog";
import { parseCommitAttributions } from "@/lib/domain/evidence/agents/commit-attribution";

/**
 * AI 흔적 더듬기 — 레포 루트 파일 목록과 최근 커밋만 보고 AI 코딩 도구를 썼다는 흔적이 있는지 가볍게 본다.
 *
 * 검색어가 "AI로 만들었다"를 말하지 않는 신호에 쓴다(settings-schema requireEvidence). 한국어로 쓴 README 를
 * 긁는 `있습니다 in:readme` 는 한국어 레포 전부가 걸리는데, 그중 AI 흔적이 있는 쪽만 들여보내야 목록의 전제가
 * 지켜진다. 2026-10-02 표본 26건: 루트 지침 파일(CLAUDE.md·AGENTS.md·.claude·.cursor) 9건, 최근 30커밋의
 * Co-authored-by 11건, 둘 중 하나라도 17건(65%).
 *
 * 정식 조사(evidence/agents/collect.ts)는 트리 전체와 커밋 변경까지 보느라 요청이 열두 번까지 든다. 여기는
 * 두 번이다 — 들여보낼지만 가리는 문턱이고, 근거의 등급은 발행 뒤 정식 조사가 따로 매긴다.
 */
export const PROBE_COMMITS = 30;
export type EvidenceProbe = { ok: true; found: string[] } | { ok: false; error: GitHubFailure };

export async function probeAiEvidence(repo: string, request: typeof githubRequest = githubRequest): Promise<EvidenceProbe> {
  const found: string[] = [];
  const root = await request<{ name?: unknown; type?: unknown }[]>(`/repos/${repo}/contents/`);
  // 빈 레포는 404 — 볼 것이 없다. 부른 쪽이 not_found 로 다룬다
  if (!root.ok) return root;
  if (root.status === 200 && Array.isArray(root.value)) {
    for (const item of root.value) {
      if (typeof item.name !== "string") continue;
      if (item.type === "dir" && (AGENT_DIRECTORY_PREFIXES as readonly string[]).includes(item.name)) found.push(`dir:${item.name}`);
      else if (item.type === "file" && matchAgentArtifact(item.name).rule) found.push(`file:${item.name}`);
    }
  }
  const commits = await request<{ commit?: { message?: unknown } }[]>(`/repos/${repo}/commits?per_page=${PROBE_COMMITS}`);
  if (!commits.ok) {
    // 커밋이 하나도 없는 레포는 409 로 답한다 — 흔적이 없을 뿐 실패가 아니다
    if (!(commits.error.kind === "http" && commits.error.status === 409)) return commits;
  } else if (commits.status === 200 && Array.isArray(commits.value)) {
    // 사람끼리의 Co-authored-by 는 세지 않는다 — 아는 도구 이름(client)으로 풀리는 표기만
    const clients = new Set<string>();
    for (const item of commits.value) {
      const message = item?.commit?.message;
      if (typeof message !== "string") continue;
      for (const attribution of parseCommitAttributions(message)) if (attribution.client) clients.add(attribution.client);
    }
    for (const client of clients) found.push(`trailer:${client}`);
  }
  return { ok: true, found };
}

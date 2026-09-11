import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";

/**
 * 저장소 README 앞부분 — AI 심사가 "이 주소가 무엇을 내놓는가"를 읽는 두 번째 창.
 *
 * 수집 문서의 75%가 본문(textSample) 없이 제목·소개만으로 판정됐다(2026-09-11 실측). README 는
 * 대개 "무엇인가·어떻게 쓰나"를 첫 화면에 적는다 — 설치 명령이 먼저면 CLI, 데모 주소가 먼저면 앱이다.
 *
 * API 대신 raw.githubusercontent.com 에서 받는다 — 심사 워커에는 GitHub 토큰이 없고, 이쪽은 API
 * 사용량을 쓰지 않는다. 기본 브랜치(HEAD)의 흔한 이름만 차례로 본다.
 */
export const README_SAMPLE_LIMIT = 3_000;
const README_NAMES = ["README.md", "readme.md", "README", "README.rst"];
const MAX_README_BYTES = 256 * 1024;

type Request = (url: string, options: { maxBytes: number; timeoutMs?: number }) => Promise<CappedFetchResult>;

/** 마크다운을 읽을 수 있는 글자로. 배지·이미지·링크 주소·HTML 은 버리고 코드(설치 명령)는 남긴다 */
export function readmeText(markdown: string, limit = README_SAMPLE_LIMIT): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim()
    .slice(0, limit);
}

/**
 * README 앞부분. 없으면 "" (다시 찾지 않도록 표시), 잠깐의 실패면 null (다음에 다시 시도).
 */
export async function fetchReadmeSample(repo: string, request: Request = fetchCapped): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return "";
  for (const name of README_NAMES) {
    const response = await request(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`, { maxBytes: MAX_README_BYTES, timeoutMs: 8_000 });
    if (response.ok && response.status === 200) return readmeText(response.body.toString("utf8"));
    if (!response.ok && response.reason === "http" && response.status === 404) continue;
    // 너무 큰 README 는 다시 받아도 크다 — 없는 것으로 친다. 그 밖(시간 초과·5xx)은 다음에 다시
    return !response.ok && response.reason === "too_large" ? "" : null;
  }
  return "";
}

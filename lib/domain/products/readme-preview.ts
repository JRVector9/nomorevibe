/**
 * 상세 README 상자에 처음 싣는 앞부분 — 블록 경계(코드 울타리 밖의 빈 줄)에서 자른다(2026-11-11 상세 HTML 줄이기).
 *
 * README 는 서버가 그린 HTML 과 같은 내용의 RSC 데이터로 두 번 실린다. 긴 README(수십~100KB)가 상세 HTML 의 대부분을 차지했고
 * (modern-web-guidance 는 링크 500개 남짓), 화면에서는 높이 480px 상자 안에서 몇 줄만 보인다.
 * 앞부분만 싣고 끝에 원문 링크를 둔다 — 원문(GitHub)이 정본이고, 이미지를 빼고 그리는 우리 사본보다 낫다.
 *
 * - 예산은 화면에 그려지는 글로 센다 — HTML 블록(<table>·<details>·<picture>…)은 skipHtml 로 그리지 않으므로 세지 않는다.
 * - 제목 한 줄로 끝나지 않게 한다(제목 아래가 잘리면 제목만 남는다).
 * - 잘린 뒤쪽의 링크 참조 정의(`[이름]: 주소`)는 앞부분에 붙여 둔다 — 앞부분의 `[글][이름]` 링크가 글자로 깨지지 않게.
 */
export const README_PREVIEW_CHARS = 6_000;
/** 남는 꼬리가 이만큼보다 짧으면 자르지 않는다 — 몇 줄 때문에 '나머지는 원문에서'를 보이지 않게 */
const README_PREVIEW_SLACK = 1_500;

export type ReadmePreview = { markdown: string; truncated: boolean };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*\S/;
const HTML_BLOCK = /^ {0,3}</;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)[^\n]*$/;
const SETEXT_HEADING = /^[^\n]+\n {0,3}(?:=+|-+)[ \t]*$/;
const LEADING_COMMENTS = /^(?:[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$))+/;

type Boundary = { offset: number; rendered: number; heading: boolean };

/** 코드 울타리를 따라가며 한 줄씩 — 울타리 줄이거나 울타리 안이면 true */
function fenceTracker() {
  let fence: string | null = null;
  return (line: string): boolean => {
    if (fence) {
      const close = line.match(FENCE_OPEN);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) fence = null;
      return true;
    }
    const open = line.match(FENCE_OPEN);
    if (open) { fence = open[1]; return true; }
    return false;
  };
}

/** 빈 줄 경계마다 — 거기까지 화면에 그려지는 글의 양, 그려지는 마지막 블록이 제목인지(그리지 않는 HTML 블록은 건너뛴다) */
function blockBoundaries(markdown: string): { list: Boundary[]; rendered: number } {
  const list: Boundary[] = [];
  const inFence = fenceTracker();
  let offset = 0;
  let start = 0;
  let rendered = 0;
  let heading = false;
  const close = (end: number) => {
    const block = markdown.slice(start, end).trim();
    // 블록 앞의 HTML 주석 줄(<!-- … -->)은 그리지 않는다 — 바로 다음 줄의 제목·글은 그린다
    const visible = block.replace(LEADING_COMMENTS, "").trim();
    if (visible && !HTML_BLOCK.test(visible)) {
      rendered += visible.length;
      heading = ATX_HEADING.test(visible) || SETEXT_HEADING.test(visible);
    }
    return block;
  };
  for (const line of markdown.split("\n")) {
    if (!inFence(line) && line.trim() === "" && offset > 0) {
      if (close(offset)) list.push({ offset, rendered, heading });
      start = offset;
    }
    offset += line.length + 1;
  }
  close(markdown.length);
  return { list, rendered };
}

export function readmePreview(markdown: string, budget = README_PREVIEW_CHARS): ReadmePreview {
  if (markdown.length <= budget + README_PREVIEW_SLACK) return { markdown, truncated: false };
  const { list, rendered } = blockBoundaries(markdown);
  if (rendered <= budget + README_PREVIEW_SLACK) return { markdown, truncated: false };
  const within = list.filter((boundary) => boundary.rendered <= budget && !boundary.heading);
  // 예산 안에 쓸 경계가 없으면(첫 블록이 큰 표·코드) 예산 뒤 첫 경계까지 — 그것도 없으면 한 덩어리라 그대로 둔다
  const chosen = within.at(-1) ?? list.find((boundary) => boundary.rendered > budget && !boundary.heading);
  if (!chosen || rendered - chosen.rendered <= README_PREVIEW_SLACK) return { markdown, truncated: false };

  const kept = markdown.slice(0, chosen.offset).trimEnd();
  const definitions: string[] = [];
  const inFence = fenceTracker();
  for (const line of markdown.slice(chosen.offset).split("\n")) {
    if (!inFence(line) && REFERENCE_DEFINITION.test(line)) definitions.push(line.trim());
  }
  return { markdown: definitions.length ? `${kept}\n\n${definitions.join("\n")}\n` : `${kept}\n`, truncated: true };
}

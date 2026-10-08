/**
 * 브랜드 표기와 페이지 제목(2026-10-08 UX 감사 UX-39).
 *
 * 표기는 로고와 같은 소문자 'nomorevibe' 하나다. 'NoMoreVibe' 를 새로 쓰지 않는다.
 * 제목은 "무엇 — nomorevibe" 꼴로 맞춘다. 검색·분야·랭킹이 홈 제목을 그대로 쓰면 탭과 방문 기록에서 구분이 안 된다.
 */

export const BRAND = "nomorevibe";

/** 사이트 한 줄 — 홈 제목과 공유 미리보기에 쓴다 */
export const SITE_TAGLINE = "AI로 만든 것들, 세상에 나오다.";

/** 홈(과 제목을 정하지 않은 화면)의 제목. 루트 레이아웃의 기본값이다 */
export const HOME_TITLE = `${BRAND} — ${SITE_TAGLINE}`;

/** 제목 조각 사이 — 여러 조각이면 "금융 · 2026년 41주 랭킹" */
const PART_SEPARATOR = " · ";

/**
 * 페이지 제목 — 빈 조각은 건너뛰고 잇고 끝에 브랜드를 붙인다. 조각이 하나도 없으면 홈 제목.
 *
 * 루트 레이아웃은 제목 틀(title.template)을 두지 않는다 — 관리자 화면 열네 곳이 이미 브랜드를 붙여 쓰고 있어 두 번 붙는다.
 * 그래서 화면이 이 함수로 완성된 제목을 넘긴다. 피드·공유 미리보기 제목도 같은 함수로 만든다.
 *
 * @example
 * pageTitle("“가계부” 검색 결과") // "“가계부” 검색 결과 — nomorevibe"
 * pageTitle("금융 프로젝트")       // "금융 프로젝트 — nomorevibe"
 * pageTitle("2026년 41주 랭킹")    // "2026년 41주 랭킹 — nomorevibe"
 * pageTitle(product.name)         // "LCU — nomorevibe"
 */
export function pageTitle(...parts: (string | null | undefined | false)[]): string {
  const text = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim()).join(PART_SEPARATOR);
  return text ? `${text} — ${BRAND}` : HOME_TITLE;
}

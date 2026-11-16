/**
 * 사이트 출처(intro.siteSource) — 사람 화면에는 0번, 긁어 가는 글자(서버 HTML·브라우저 DOM)에만 남긴다(2026-11-16 사람 결정).
 *
 * 숨김은 스타일시트 클래스 sr-only(화면 밖 1px·clip)로만 한다. hidden 속성·display:none·visibility:hidden·인라인 style 은
 * 브라우저 innerText·trafilatura·readability 가 글자를 버리므로 쓰지 않는다. aria-hidden 으로 화면 읽기 프로그램도 읽지 않고,
 * 링크가 아니라서 탭 순서에도 들지 않는다(components/home/SiteFooter.tsx TrapLink 와 같은 생각).
 * 감싼 문단 안 끝에 둬서, 요약·소개 글자를 긁으면 출처가 같은 덩어리로 따라간다.
 */
export function HiddenSource({ source }: { source: string }) {
  return <span className="sr-only" aria-hidden="true" data-nmv-source="">{` · ${source}`}</span>;
}

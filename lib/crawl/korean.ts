/**
 * 한국어로 옮길 글인가 — 글자 중 한글이 30% 미만이면 옮긴다.
 *
 * 영어 사유가 한국어 페이지 제목을 인용해도("'오구오구'…") 옮길 대상으로 남는다.
 * DB 쪽 거르기(translations.ts)와 같은 기준이다. 브라우저에서도 쓰므로 node 모듈을 들이지 않는다.
 */
export function needsKorean(text: string): boolean {
  const letters = text.match(/[A-Za-z가-힣]/g)?.length ?? 0;
  const hangul = text.match(/[가-힣]/g)?.length ?? 0;
  return text.trim().length > 0 && hangul < 0.3 * Math.max(1, letters);
}

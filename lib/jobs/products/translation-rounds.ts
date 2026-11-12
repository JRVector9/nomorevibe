/**
 * 공개 번역 한 틱에 호출 없이 넘길 수 있는 묶음 수 상한 — 고르기·장부 요청이 틱마다 끝없이 돌지 않게 한다.
 * 칸 수를 적지 않은 「동시에」·순위대로의 동시 처리 수도 이 값에서 자른다(translations.ts). 관리 화면 설명(pool-help)이 같은 값을 읽는다.
 */
export const PRODUCT_TRANSLATION_SELECTION_ROUNDS = 8;

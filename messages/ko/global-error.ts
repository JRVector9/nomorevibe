/** Standalone root failure UI cannot receive a dictionary from the failed layout. */
export const globalError = {
  title: "오류",
  heading: "사이트를 불러오지 못했습니다",
  description: "잠깐 생긴 문제일 수 있습니다. 다시 시도해 보시고, 계속되면 잠시 후 다시 들러 주세요.",
  retry: "다시 시도",
  home: "홈으로 가기",
  reference: "오류 번호 {digest}",
} as const;

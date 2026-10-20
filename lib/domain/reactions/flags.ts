/** 써봤어요(익명 평가·상세 써보기 판·마이페이지 써봤어요 탭) — 기본 꺼짐. 끄면 API 는 404, 판은 그리지 않는다 */
export function productReactionsEnabled(): boolean {
  return process.env.PRODUCT_REACTIONS_ENABLED === "true";
}

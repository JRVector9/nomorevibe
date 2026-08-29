/**
 * 메인이 아닌 경로에서 상단 줄을 내리는 자리.
 *
 * default.tsx만으로는 부족하다. 병렬 라우트는 소프트 내비게이션(next/link)에서 슬롯의
 * 이전 활성 상태를 그대로 유지하고, default.tsx는 새로고침 같은 하드 내비게이션에서만
 * 쓰인다. 그래서 홈에서 제품 카드를 누르면 상세 페이지에 홈의 숫자 줄이 따라왔다.
 * 모든 하위 경로에 null을 내는 페이지를 두어야 슬롯이 실제로 닫힌다.
 */
export default function NoTopbar() {
  return null;
}

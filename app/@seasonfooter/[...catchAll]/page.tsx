/**
 * 메인이 아닌 경로에서 시즌 줄을 내리는 자리.
 *
 * default.tsx는 하드 내비게이션에서만 쓰인다. 소프트 내비게이션은 슬롯의 이전 활성
 * 상태를 유지하므로, 홈에서 링크를 눌러 이동하면 홈에서 잡은 now로 굳은 카운트다운이
 * 상세 페이지 푸터에 그대로 남았다. 하위 경로 전부에 null을 내야 닫힌다.
 */
export default function NoSeasonFooter() {
  return null;
}

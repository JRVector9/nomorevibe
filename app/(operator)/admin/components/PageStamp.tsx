import { RenderedAt } from "./RenderedAt";

/**
 * 관리자 화면마다 하나 — 서버가 이 화면을 그린 시각을 머리 갱신 줄("마지막 갱신")에 알린다(render-clock.ts).
 * 새 관리자 화면에도 넣는다(tests/admin-live-refresh.test.tsx 가 모든 화면을 확인한다).
 */
export function PageStamp() {
  return <RenderedAt at={new Date().toISOString()} />;
}

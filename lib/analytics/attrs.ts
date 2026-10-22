import type { AnalyticsEventName, AnalyticsEventParams, AnalyticsSurface } from "@/lib/analytics/events";

/**
 * 화면에 다는 분석 표시(2026-10-22) — 누르면 무엇을 보낼지 HTML 속성으로 적어 두고, 런타임의 클릭 하나가 읽는다
 * (lib/analytics/dom.ts). 컴포넌트마다 onClick 에 분석 코드를 흩지 않고, 이동을 막지도 않는다.
 *
 * 속성(모두 data-*)
 * - data-track + data-track-params: 이 요소를 누르면 그 이벤트(매개변수는 JSON). trackAttrs() 로 만든다.
 *   surface 를 빼면 가장 가까운 data-track-surface 나 화면 갈래로 채운다.
 * - data-track-view + data-track-params: 이 요소가 화면에 절반 넘게 들어오면 그 이벤트를 화면당 한 번(/launch 단계).
 * - data-track-list(+ data-track-list-name): 이 안의 제품 링크(/p/<slug>)는 select_item 의 그 목록이다.
 *   없으면 가장 가까운 id·aria-labelledby 로 목록 이름을 짓는다.
 * - data-track-nav: 이 안의 링크는 nav_click(값이 surface — header·footer·mobile_nav).
 * - data-track-filter: 이 안의 링크는 filter_change(값이 filter_name, filter_value 는 data-track-value 나 링크의 그 질의 값).
 * - data-track-surface: 이 안에서 일어난 이벤트의 surface.
 * - data-track-product: 이 안의 GitHub·화제 원문 링크가 가리키는 제품 slug(상세 화면이면 주소에서 안다).
 * - data-track-kind: /go 링크의 link_kind(site·repo).
 * - data-track-ignore: 이 안의 클릭은 보내지 않는다.
 *
 * 이 파일은 모든 화면의 첫 로드 JS 에 들어가므로 값을 만드는 일 말고는 하지 않는다.
 */

type WithOptionalSurface<P> = P extends { surface: AnalyticsSurface }
  ? Omit<P, "surface"> & { surface?: AnalyticsSurface }
  : P;

export type TrackAttributes = { "data-track": AnalyticsEventName; "data-track-params": string };
export type TrackViewAttributes = { "data-track-view": AnalyticsEventName; "data-track-params": string };

/** 누르면 보낼 이벤트 — JSX 에 펼쳐 단다: <button {...trackAttrs("product_save", {…})}> */
export function trackAttrs<Name extends AnalyticsEventName>(name: Name, params: WithOptionalSurface<AnalyticsEventParams[Name]>): TrackAttributes {
  return { "data-track": name, "data-track-params": JSON.stringify(params) };
}

/** 화면에 들어오면 한 번 보낼 이벤트 */
export function trackViewAttrs<Name extends AnalyticsEventName>(name: Name, params: WithOptionalSurface<AnalyticsEventParams[Name]>): TrackViewAttributes {
  return { "data-track-view": name, "data-track-params": JSON.stringify(params) };
}

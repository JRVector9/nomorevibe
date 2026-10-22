"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics/client";
import type { AnalyticsEventName, AnalyticsEventParams } from "@/lib/analytics/events";

/**
 * 그려지면 이벤트 하나 — 서버가 아는 값(검색 결과 수, 404)을 화면에 실어 보낸다(2026-10-22).
 * 같은 값으로 다시 그려지면 다시 보내지 않는다. 아무것도 그리지 않는다.
 */
export function TrackOnMount<Name extends AnalyticsEventName>({ name, params }: { name: Name; params: AnalyticsEventParams[Name] }) {
  const key = JSON.stringify(params);
  useEffect(() => {
    track(name, JSON.parse(key) as AnalyticsEventParams[Name]);
  }, [name, key]);
  return null;
}

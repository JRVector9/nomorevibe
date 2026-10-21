"use client";

import { useEffect } from "react";
import { publishRenderedAt } from "./render-clock";

/** 서버가 이 화면을 그린 시각을 머리 갱신 줄에 알린다. 아무것도 그리지 않는다 */
export function RenderedAt({ at }: { at: string }) {
  useEffect(() => { publishRenderedAt(at); }, [at]);
  return null;
}

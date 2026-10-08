"use client";
import { useEffect } from "react";

/**
 * 주소의 #id 로 내려간다.
 *
 * 어드민은 loading.tsx 골격이 먼저 그려져, Next 의 해시 스크롤이 id 가 없는 골격에서 끝나고 본문이 들어온 뒤에는
 * 다시 찾지 않는다 — 운영센터의 "2차 심사 설정 → /admin#second"가 4,600px 설정 화면 맨 위에 멈췄다(2026-10-08 감사 ADM-03).
 * 본문과 함께 붙는 이 조각이 그때 한 번 찾는다.
 */
export function ScrollToHash() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);
  return null;
}

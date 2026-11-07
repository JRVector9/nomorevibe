"use client";
import { useEffect } from "react";

/**
 * 주소의 #id 로 내려간다 — 고급 설정의 본문은 Suspense 뒤에 늦게 붙어 Next 의 해시 스크롤이 놓친다(ScrollToHash 와 같은 까닭).
 * 대상이 접힌 <details> 안(예: 옛 ?advanced=1#model-settings → 단계별 모델 풀)이면 먼저 펼친다. 화면 안 링크(#model-settings)로 옮길 때도 같다.
 */
export function HashTarget() {
  useEffect(() => {
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      for (let details = target.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
      target.scrollIntoView();
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  return null;
}

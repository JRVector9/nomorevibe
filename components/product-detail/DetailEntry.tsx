"use client";

import { useLayoutEffect } from "react";

/** 상세 진입 때 이전 스크롤 위치를 복원하지 않고 처음부터 보여 준다. */
export function DetailEntry({ slug }: { slug: string }) {
  useLayoutEffect(() => {
    let frame: number | null = null;
    const reset = () => {
      // 출처·업데이트를 가리킨 명시적인 구획 링크는 그대로 따른다.
      if (window.location.pathname === `/p/${slug}` && !window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    };
    const enter = () => {
      reset();
      if (frame !== null) cancelAnimationFrame(frame);
      // 뒤로 가기의 브라우저 위치 복원은 layout effect 뒤에 일어나므로 다음 프레임에도 맞춘다.
      frame = requestAnimationFrame(() => { frame = null; reset(); });
    };
    enter();
    window.addEventListener("pageshow", enter);
    return () => {
      window.removeEventListener("pageshow", enter);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [slug]);
  return null;
}

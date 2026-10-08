"use client";
import { useEffect, useRef, useState } from "react";

/**
 * 조치 한 칸의 설명 — 두 줄까지 보이고, 넘치면 "더 보기"로 펼친다.
 *
 * 전에는 한 줄에서 말줄임으로 잘리고 title 도 없어 전문을 읽을 길이 없었다(2026-10-08 감사 ADM-02).
 * 넘치는지는 그려 본 뒤에야 알 수 있어 크기를 지켜본다 — 넘치지 않는 줄에는 단추를 달지 않는다.
 */
export function AttentionDetail({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // 지켜보기 시작할 때 한 번 불리므로 따로 재지 않는다
    const observer = new ResizeObserver(() => setClamped(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div ref={ref} className="d" data-open={open || undefined}>{children}</div>
      {(clamped || open) && (
        <button type="button" className="dash-todo-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "접기" : "더 보기"}
        </button>
      )}
    </>
  );
}

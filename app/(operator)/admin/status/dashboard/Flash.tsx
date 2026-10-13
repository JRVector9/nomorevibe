'use client';
import { useEffect, useRef } from 'react';

/**
 * 자동 갱신으로 값이 바뀌면 1초 동안 강조한다(2026-10-08 UX 감사 ADM-35) — 10초마다 다시 그려도 무엇이 바뀌었는지 보이게.
 *
 * 처음 그릴 때는 켜지 않는다. 상태를 쓰지 않고 data-changed 만 붙였다 떼어 다시 그리지 않는다.
 * 움직임 줄이기 설정에서는 서서히 바뀌지 않고 바로 켜졌다 꺼진다(dashboard.css).
 */
export function Flash({ value, children }: { value: unknown; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    const element = ref.current;
    if (!element) return;
    element.dataset.changed = 'true';
    const timer = setTimeout(() => { delete element.dataset.changed; }, 1_000);
    return () => clearTimeout(timer);
  }, [value]);
  return <span ref={ref} className="ops-flash">{children}</span>;
}

"use client";

import { useEffect, useEffectEvent, useId, useRef } from "react";

const CLOSE_DELAY_MS = 160;
const EDGE = 12;

/**
 * 도움말 단추(ⓘ)와 그 설명 — 마우스를 올리거나, 키보드로 단추에 오거나(포커스), 눌러서(휴대폰 탭) 연다.
 * 누르면 그 자리에 고정되고 다시 누르거나 Esc·바깥을 누르면 닫힌다. 올리기·포커스로 연 것은 벗어나면 닫힌다.
 * 설명은 popover(수동) 라 표의 옆 넘김·패널 안에서도 잘리지 않고 화면 맨 위에 뜬다 — 단추 아래(자리가 없으면 위)에 붙여 둔다.
 */
export function HelpTip({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  const id = `help-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const timer = useRef<number | null>(null);

  const isOpen = () => !!pop.current?.matches(":popover-open");
  const clear = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  const place = () => {
    const el = pop.current, anchor = button.current;
    if (!el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const width = Math.min(520, vw - EDGE * 2);
    el.style.width = `${width}px`;
    el.style.left = `${Math.min(Math.max(EDGE, rect.left), vw - width - EDGE)}px`;
    const below = vh - rect.bottom - 6 - EDGE, above = rect.top - 6 - EDGE;
    if (below >= 260 || below >= above) {
      el.style.top = `${rect.bottom + 6}px`; el.style.bottom = "auto"; el.style.maxHeight = `${Math.max(160, below)}px`;
    } else {
      el.style.top = "auto"; el.style.bottom = `${vh - rect.top + 6}px`; el.style.maxHeight = `${Math.max(160, above)}px`;
    }
  };
  const show = () => {
    clear();
    const el = pop.current;
    if (!el || isOpen()) return;
    el.showPopover();
    place();
    button.current?.setAttribute("aria-expanded", "true");
  };
  const hide = () => {
    clear();
    pinned.current = false;
    if (isOpen()) pop.current?.hidePopover();
    button.current?.setAttribute("aria-expanded", "false");
  };
  /** 올리기·포커스로 연 것만 — 단추·설명 위에 마우스가 없고 포커스도 그 밖이면 닫는다 */
  const hideSoon = () => {
    if (pinned.current) return;
    clear();
    timer.current = window.setTimeout(() => {
      const el = pop.current, anchor = button.current;
      if (pinned.current || !el || !anchor) return;
      const inside = (node: Element | null) => !!node && (el.contains(node) || anchor.contains(node));
      if (el.matches(":hover") || anchor.matches(":hover") || inside(document.activeElement)) return;
      hide();
    }, CLOSE_DELAY_MS);
  };

  // 열린 동안 — Esc 와 바깥 누르기로 닫고, 스크롤·창 크기가 바뀌면 다시 붙인다(듣는 쪽은 한 번만 달고, 부르는 함수는 늘 지금 것 — useEffectEvent)
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isOpen()) return;
    hide();
    button.current?.focus();
  });
  const onDown = useEffectEvent((event: PointerEvent) => {
    const target = event.target as Node | null;
    if (!isOpen() || !target || pop.current?.contains(target) || button.current?.contains(target)) return;
    hide();
  });
  const onMove = useEffectEvent(() => { if (isOpen()) place(); });
  useEffect(() => {
    const key = (event: KeyboardEvent) => onKey(event), down = (event: PointerEvent) => onDown(event), move = () => onMove();
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    };
  }, []);

  return <>
    <button ref={button} type="button" className={`cs-help${className ? ` ${className}` : ""}`} aria-label={`${label} 설명`} aria-controls={id} aria-expanded="false"
      aria-haspopup="dialog"
      onClick={() => { if (isOpen() && pinned.current) hide(); else { show(); pinned.current = true; } }}
      onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={hideSoon}>
      <span aria-hidden="true">?</span>
    </button>
    <div ref={pop} id={id} popover="manual" role="dialog" aria-label={`${label} 설명`} className="cs-help-pop"
      onMouseEnter={clear} onMouseLeave={hideSoon} onBlur={hideSoon}>
      {children}
    </div>
  </>;
}

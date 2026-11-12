"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Native modal keeps keyboard focus inside the right drawer and restores it on close. */
export function ModelDrawer({ title, eyebrow, titleId, onClose, children }: {
  title: string; eyebrow: string; titleId: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    const overflowBefore = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { node.close(); document.body.style.overflow = overflowBefore; focusBefore?.focus(); };
  }, []);
  return <dialog ref={dialog} className="mc-drawer" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}>
    <div className="mc-drawer-head"><div><span className="mc-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
      <button type="button" className="mc-close" aria-label={`${title} 닫기`} onClick={onClose}>×</button></div>
    <div className="mc-drawer-content">{children}</div>
  </dialog>;
}

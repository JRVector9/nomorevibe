"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 단계 패널을 열면 제목으로 초점을 옮기고, Esc 로 닫는다(주소에서 ?stage= 를 뺀다). 고치는 중(data-dirty)이거나 글자를 넣는 중이면 Esc 를 그 칸에 둔다.
 * 패널은 대화상자가 아니라서(자동 갱신이 멈추지 않게) 이 작은 조각만 브라우저에서 돈다.
 */
export function StagePanelKeys({ closeHref }: { closeHref: string }) {
  const router = useRouter();
  useEffect(() => {
    document.getElementById("sp-title")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [data-dirty], [data-confirm-open]") || document.querySelector(".sp [data-dirty]")) return;
      router.push(closeHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref, router]);
  return null;
}

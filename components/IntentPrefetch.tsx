"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { connectionAllowsPrefetch, IntentPrefetcher, intentPrefetchPath } from "@/lib/web/intent-prefetch";

type AppRouter = ReturnType<typeof useRouter>;
type PrefetchKind = NonNullable<Parameters<AppRouter["prefetch"]>[1]>["kind"];
/**
 * 화면 전체를 받는다. 기본값(auto)은 동적 화면에서 경로 틀(`/_tree`)·메타데이터만 받아 와 누를 때 서버 왕복이 그대로 남는다.
 * full 로 받은 것은 next.config.ts 의 staleTimes.static(30초) 동안 이동에 그대로 쓴다.
 */
const FULL_PREFETCH = "full" as PrefetchKind;

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

function anchorPath(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  return intentPrefetchPath({ href: anchor.href, target: anchor.target, download: anchor.hasAttribute("download") }, window.location);
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 공개 화면 틀(PublicShell)에 한 번 건다. 링크마다 고치지 않고 문서에서 이벤트를 받아 링크를 찾는다.
 * 마우스(펜)가 머문 링크와 키보드 초점이 간 링크만 받는다 — 터치·누르는 순간은 받지 않는다(lib/web/intent-prefetch.ts).
 * 링크의 prefetch={false}(화면에 보이기만 해도 받는 일 끄기)는 그대로 둔다 — 여기서는 의도가 보인 링크만 받는다(lib/web/intent-prefetch.ts).
 */
export function IntentPrefetch() {
  const router = useRouter();

  useEffect(() => {
    // Next 도 개발 서버에서는 미리 받지 않는다
    if (process.env.NODE_ENV !== "production") return;
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    const prefetcher = new IntentPrefetcher({
      prefetch: (path) => {
        // 이동이 끝나 이미 그 화면이면 받지 않는다(포인터가 움직이지 않아 이전 화면의 링크가 남아 있을 때)
        if (path === `${window.location.pathname}${window.location.search}`) return;
        if (!connectionAllowsPrefetch(connection)) return;
        router.prefetch(path, { kind: FULL_PREFETCH });
      },
    });

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const path = anchorPath(event.target);
      if (path) prefetcher.enter(path);
      else prefetcher.leave();
    };
    const onPointerOut = (event: PointerEvent) => {
      // 창 밖으로 나갔다
      if (event.relatedTarget === null) prefetcher.leave();
    };
    // 누르기·키 입력: 아직 나가지 않은 미리 받기를 버린다 — 이동이 시작된 뒤에 나가면 이동 요청과 겹쳐 오히려 늦어진다.
    // 누르는 순간에 새로 받지도 않는다(손가락 탭 포함) — 이유는 lib/web/intent-prefetch.ts
    const onPress = () => prefetcher.cancel();
    const onFocusIn = (event: FocusEvent) => {
      // 키보드로 고른 링크만 — 마우스·손가락이 누르며 준 초점으로는 받지 않는다(이동 요청과 겹친다)
      if (!(event.target instanceof Element) || !focusVisible(event.target)) return;
      const path = anchorPath(event.target);
      if (path) prefetcher.enter(path);
    };
    const onFocusOut = (event: FocusEvent) => {
      const path = anchorPath(event.target);
      if (path) prefetcher.leave(path);
    };

    const passive = { capture: true, passive: true } as const;
    document.addEventListener("pointerover", onPointerOver, passive);
    document.addEventListener("pointerout", onPointerOut, passive);
    document.addEventListener("pointerdown", onPress, passive);
    document.addEventListener("keydown", onPress, passive);
    document.addEventListener("focusin", onFocusIn, passive);
    document.addEventListener("focusout", onFocusOut, passive);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, passive);
      document.removeEventListener("pointerout", onPointerOut, passive);
      document.removeEventListener("pointerdown", onPress, passive);
      document.removeEventListener("keydown", onPress, passive);
      document.removeEventListener("focusin", onFocusIn, passive);
      document.removeEventListener("focusout", onFocusOut, passive);
      prefetcher.dispose();
    };
  }, [router]);

  return null;
}

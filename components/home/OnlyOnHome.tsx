"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { stripLocale } from "@/lib/i18n/routing";

/**
 * 메인("/")에서만 자식을 보인다 — 푸터 시즌 줄 슬롯의 문지기.
 *
 * 병렬 라우트 슬롯은 소프트 내비게이션에서 이전 활성 상태를 유지한다. 홈에서 링크로 옮기면 홈에서 잡은
 * now 로 굳은 카운트다운이 다른 페이지 푸터에 남는다. 예전에는 슬롯에 [...catchAll]/page.tsx 를 둬서 닫았는데,
 * 그 catch-all 이 없는 주소를 전부 '있는 경로'로 만들어 루트 404 서버 렌더가 오류 셸(<html id="__next_error__">,
 * lang 없음, JS 끄면 백지)로 떨어졌다(2026-10-08 UX 점검 ROB-01). 그래서 슬롯 대신 경로로 닫는다.
 */
export function OnlyOnHome({ children }: { children: ReactNode }) {
  return stripLocale(usePathname()) === "/" ? children : null;
}

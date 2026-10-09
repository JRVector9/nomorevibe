"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { AdminIcon, type AdminIconName } from "./AdminIcon";

/**
 * 관리자 화면 테마(2026-10-08 UX 감사 ADM-25) — 라이트/다크/시스템, 이 브라우저에만 기억한다(localStorage).
 *
 * 고른 값은 html 의 data-admin-theme 으로 단다. 시스템이면 속성을 지워 admin.css 의 prefers-color-scheme 이 따르게 한다.
 * 이 속성은 admin.css 가 .admin-area 가 있는 body 에만 적용한다 — 공개 사이트는 따로 시스템 설정(prefers-color-scheme)을 따른다(UX-34).
 */
export type AdminTheme = "light" | "dark" | "system";

const STORAGE_KEY = "nmv-admin-theme";
const CHANGE_EVENT = "nmv-admin-theme-change";
const CHOICES: [AdminTheme, string, AdminIconName][] = [["light", "라이트", "sun"], ["dark", "다크", "moon"], ["system", "시스템", "monitor"]];

/**
 * 첫 그리기 전에 테마를 다는 인라인 스크립트(next 가이드 preventing-flash-before-hydration).
 * AdminShell 이 .admin-area 앞에 둔다 — 그래서 저장된 다크가 흰 화면으로 한 번 번쩍이지 않는다.
 */
export const ADMIN_THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-admin-theme",t)}catch(e){}`;

function storedTheme(): AdminTheme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: AdminTheme) {
  if (theme === "system") document.documentElement.removeAttribute("data-admin-theme");
  else document.documentElement.setAttribute("data-admin-theme", theme);
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function ThemeToggle() {
  // 서버는 저장값을 모르니 "시스템"으로 그리고, hydration 뒤 저장값으로 바꾼다(불일치 오류 없이)
  const theme = useSyncExternalStore(subscribe, storedTheme, () => "system" as const);
  // 개발 모드 Strict Mode 재마운트가 html 의 속성을 지운다 — 그리기 전에 저장값으로 다시 단다(운영에서는 같은 값을 다시 다는 것뿐)
  useLayoutEffect(() => applyTheme(storedTheme()), []);

  const choose = (next: AdminTheme) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 저장이 막힌 브라우저(사생활 모드 등) — 이번 화면에만 적용한다
    }
    applyTheme(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return (
    <div className="admin-theme" role="group" aria-label="화면 테마">
      {CHOICES.map(([value, label, icon]) => (
        <button key={value} type="button" aria-pressed={theme === value} title={`테마: ${label}`} onClick={() => choose(value)}>
          <AdminIcon name={icon} size={14} /><span className="admin-sidebar-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

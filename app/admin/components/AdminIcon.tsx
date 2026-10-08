/**
 * 관리자 화면의 선 아이콘(24 격자, 1.6 선) — 공개 사이트 components/home/icons.tsx 와 같은 방식이다.
 * 장식이라 늘 aria-hidden 이다. 뜻은 옆 글자(접히면 .admin-vh 글자)가 전한다.
 */
const PATHS = {
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  check: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  inbox: <><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5.5 6h13L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z" /></>,
  down: <><path d="M12 4v11m-5-5 5 5 5-5" /><path d="M5 20h14" /></>,
  box: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>,
  sliders: <path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" />,
  tag: <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></>,
  bars: <path d="M5 20V11m7 9V5m7 15v-6M3 20h18" />,
  news: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-4 4 3 3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8m-4-4v4" /></>,
  logout: <path d="M10 4H5v16h5m4-12 4 4-4 4m4-4H9" />,
  external: <path d="M14 4h6v6m0-6-9 9M18 14v6H4V6h6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} as const;

export type AdminIconName = keyof typeof PATHS;

export function AdminIcon({ name, size = 18 }: { name: AdminIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

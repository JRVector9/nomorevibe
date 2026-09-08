const PATHS: Record<string, React.ReactNode> = {
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  bookmark: <path d="M6 4h12v17l-6-4-6 4z" />,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  "arrow-up-right": <path d="M6 18 18 6M6 6h12v12" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />,
  pen: <path d="m15 3 6 6-12 12H3v-6zM12 6l6 6" />,
  news: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h5" /></>,
  up: <path d="m7 14 5-5 5 5" />,
  sparkles: <path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3zM20 2v4m-2-2h4" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.grid}
    </svg>
  );
}

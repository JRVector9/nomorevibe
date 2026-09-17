import Link from "next/link";
import type { ReactNode } from "react";
import { href, type DemoProduct } from "./data";
export function Icon({
  name = "arrow",
  size = 20,
}: {
  name?: string;
  size?: number;
}) {
  const paths: Record<string, ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h16m-6-6 6 6-6 6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    rocket: (
      <>
        <path d="M14 5c3-2 5-2 6-1 1 4-2 8-6 10l-5-5 5-4Z" />
        <circle cx="15.5" cy="8" r="1.5" />
        <path d="m9 9-5 1-2 4 6-1m6 1-1 6-4 2-1-6M5 17l-2 4 4-2" />
      </>
    ),
    radar: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1" />
        <path d="m13 11 7-7" />
      </>
    ),
    feedback: (
      <>
        <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 3-2Z" />
        <path d="M7 10h.01M12 10h.01M17 10h.01" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="7" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2H4Z" />
      </>
    ),
    agent: (
      <>
        <rect x="3" y="7" width="18" height="14" rx="4" />
        <path d="M12 3v4M8 13h.01M16 13h.01M8 17h8" />
        <circle cx="12" cy="2" r="1" />
      </>
    ),
    check: <path d="m5 12 4 4L20 5" />,
    bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v6l4 2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z" />
        <path d="m8 11 3 3 5-6" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    plus: <path d="M12 4v16M4 12h16" />,
    bell: (
      <>
        <path d="M5 16V9a7 7 0 0 1 14 0v7l2 2H3l2-2Zm4 5h6" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />
      </>
    ),
    coin: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 8a5 5 0 1 0 0 8" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    leaf: (
      <>
        <path d="M12 21V9m0 6C3 15 3 8 4 3c6 0 8 4 8 7 2-6 6-7 8-7 1 10-3 13-8 15" />
      </>
    ),
    star: <path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-6Z" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.arrow}
    </svg>
  );
}
export function ButtonLink({
  to,
  children,
  secondary = false,
  className = "",
}: {
  to: string;
  children: ReactNode;
  secondary?: boolean;
  className?: string;
}) {
  return (
    <Link
      className={`d-button ${secondary ? "secondary" : ""} ${className}`}
      href={href(to)}
    >
      {children}
    </Link>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`d-badge ${tone}`}>{children}</span>;
}
export function Logo({
  product,
  large = false,
}: {
  product: DemoProduct;
  large?: boolean;
}) {
  return (
    <span
      className={`d-logo ${product.tone} ${large ? "large" : ""}`}
      aria-hidden="true"
    >
      {product.glyph === "wave" ? (
        <span className="d-wave">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : product.glyph === "dots" ? (
        <span className="d-dots">✣</span>
      ) : product.glyph === "triangle" ? (
        <span>▲</span>
      ) : product.glyph === "leaf" ? (
        <Icon name="leaf" size={32} />
      ) : (
        product.glyph
      )}
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
  center = false,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  center?: boolean;
}) {
  return (
    <header className={`d-heading ${center ? "center" : ""}`}>
      <div>
        {eyebrow && <span className="d-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Panel({
  title,
  icon,
  children,
  aside,
  className = "",
}: {
  title?: string;
  icon?: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`d-panel ${className}`}>
      {title && (
        <div className="d-panel-title">
          <h2>
            {icon && <Icon name={icon} />} {title}
          </h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="d-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({
  title = "아직 표시할 내용이 없어요",
  body = "새로운 활동이 생기면 이곳에서 확인할 수 있습니다.",
  action,
}: {
  title?: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="d-empty">
      <span className="d-icon-surface">
        <Icon name="feedback" size={28} />
      </span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
export function Notice({
  children,
  tone = "blue",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`d-notice ${tone}`}>
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
  label = "보기 선택",
}: {
  items: string[];
  value: string;
  onChange: (x: string) => void;
  label?: string;
}) {
  return (
    <div className="d-tabs" role="group" aria-label={label}>
      {items.map((x) => (
        <button
          type="button"
          key={x}
          aria-pressed={value === x}
          className={value === x ? "active" : ""}
          onClick={() => onChange(x)}
        >
          {x}
        </button>
      ))}
    </div>
  );
}

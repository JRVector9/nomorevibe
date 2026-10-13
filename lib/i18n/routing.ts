import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

/** Paths in this module are same-origin relative URLs, including query and hash. */
function splitPath(path: string): { pathname: string; suffix: string } {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) {
    throw new Error("Expected a same-origin absolute path");
  }
  const suffixAt = path.search(/[?#]/);
  return suffixAt < 0
    ? { pathname: path, suffix: "" }
    : { pathname: path.slice(0, suffixAt), suffix: path.slice(suffixAt) };
}

export function pathLocale(path: string): Locale | null {
  const { pathname } = splitPath(path);
  const segment = pathname.split("/", 2)[1];
  return isLocale(segment) ? segment : null;
}

/** Remove only a registered locale. Identifiers, query values, and hashes stay intact. */
export function stripLocale(path: string): string {
  const { pathname, suffix } = splitPath(path);
  const locale = pathLocale(pathname);
  if (!locale) return path;
  return `${pathname.slice(locale.length + 1) || "/"}${suffix}`;
}

/** Korean keeps its existing unprefixed canonical addresses. */
export function localePath(locale: Locale, logicalPath: string): string {
  if (!isLocale(locale)) throw new Error("Unsupported locale");
  const { pathname, suffix } = splitPath(stripLocale(logicalPath));
  return `${locale === DEFAULT_LOCALE ? "" : `/${locale}`}${pathname === "/" && locale !== DEFAULT_LOCALE ? "" : pathname}${suffix}`;
}

export function switchLocale(path: string, locale: Locale): string {
  return localePath(locale, stripLocale(path));
}

/** Machine endpoints and public files retain their existing contracts. */
export function isLocaleExcludedPath(pathname: string): boolean {
  const first = pathname.split("/", 2)[1];
  return ["api", "admin", "_next", "go", "badge", "webhooks", "oauth"].includes(first)
    || pathname.split("/").some((segment) => segment.includes("."))
    || ["/sitemap", "/sitemaps", "/robots", "/manifest", "/install.sh", "/skill.md"].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Public account return addresses cannot target admin, API, or machine routes. */
export function safePublicReturnUrl(value: unknown, fallback: string = "/"): string {
  if (typeof value !== "string" || value.length > 2_000) return fallback;
  try {
    splitPath(value);
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(decoded)) return fallback;
    const parsed = new URL(value, "https://return.invalid");
    if (parsed.origin !== "https://return.invalid" || parsed.pathname.startsWith("//")) return fallback;
    const logical = stripLocale(decodeURIComponent(parsed.pathname));
    if (isLocaleExcludedPath(logical)) return fallback;
    const publicRoute = /^(?:\/|\/(?:rising|popular|login|launch|policy)\/?|\/c\/[^/]+\/?|\/p\/[^/]+(?:\/github)?\/?|\/rankings\/[^/]+\/?|\/feedback\/[1-9]\d*\/?)$/;
    if (!publicRoute.test(logical)) return fallback;
    const locale = pathLocale(parsed.pathname) ?? DEFAULT_LOCALE;
    return localePath(locale, `${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return fallback;
  }
}

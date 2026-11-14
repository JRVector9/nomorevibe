import "server-only";
import { HOME_PAGE_SIZE } from "@/components/home/browse-state";

export type PaginationParams = Record<string, string | string[] | undefined>;
export type PaginationKind = "home" | "page";

/** Server-only deployment setting; invalid configuration falls back to the safe default. */
export function publicListMaxPages(value = process.env.PUBLIC_LIST_MAX_PAGES): number {
  const parsed = value && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  // Keep both the page offset and the cumulative home window within safe integers.
  return Number.isSafeInteger(parsed) && parsed <= Math.floor(Number.MAX_SAFE_INTEGER / 15) ? parsed : 100;
}

/** Check the raw input before permissive UI parsers or any list/count/search reads. */
export function publicPaginationBlocked(params: PaginationParams, kind: PaginationKind): boolean {
  const newOnly = params.new === "1" || Array.isArray(params.new) && params.new[0] === "1";
  const key = kind === "home" && !newOnly ? "shown" : "page";
  const raw = params[key];
  if (raw === undefined) return false;
  if (Array.isArray(raw) || !/^[1-9][0-9]*$/.test(raw)) return true;
  const value = Number(raw);
  const max = publicListMaxPages() * (key === "shown" ? HOME_PAGE_SIZE : 1);
  return !Number.isSafeInteger(value) || value > max;
}

/** Keep search/filter/snapshot context, returning to the first slice of this list. */
export function paginationRestartHref(path: string, params: PaginationParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "shown" || key === "page" || key === "_rsc" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

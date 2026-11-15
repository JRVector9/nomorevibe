/** Shared browser/server boundary. Maker edit-token resources and mutations keep their existing authentication. */
export function isSessionRead(path: string, method: string): boolean {
  if (method === "POST") return path === "/api/product-summaries";
  if (method !== "GET" && method !== "HEAD") return false;
  return path === "/api/product-cards" || /^\/api\/products\/[^/]+(?:\/(?:details|readme|feedback|reactions|hero|counts))?$/.test(path);
}

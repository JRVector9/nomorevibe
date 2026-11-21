/** Routes using guardPublicApiRead, indexed by its existing diagnostic and quota keys. */
export const PUBLIC_API_READS = {
  session: { path: "/api/session", methods: ["GET", "POST"], requiresSession: false },
  "products.cards": { path: "/api/product-cards", methods: ["GET"], requiresSession: true },
  "products.counts": { path: "/api/browse-counts", methods: ["GET"], requiresSession: true },
  "products.summaries": { path: "/api/product-summaries", methods: ["POST"], requiresSession: true },
  "products.get": { path: "/api/products/[slug]", methods: ["GET"], requiresSession: true },
  "products.details": { path: "/api/products/[slug]/details", methods: ["GET"], requiresSession: true },
  "products.readme": { path: "/api/products/[slug]/readme", methods: ["GET"], requiresSession: true },
  "products.timeline": { path: "/api/products/[slug]/timeline", methods: ["GET"], requiresSession: true },
  "products.feedback.list": { path: "/api/products/[slug]/feedback", methods: ["GET"], requiresSession: true },
  "products.reactions.read": { path: "/api/products/[slug]/reactions", methods: ["GET"], requiresSession: true },
  "products.talk": { path: "/api/products/[slug]/talk", methods: ["GET"], requiresSession: true },
  "rankings.season": { path: "/api/rankings/[key]", methods: ["GET"], requiresSession: true },
  "talk.board": { path: "/api/talk-board", methods: ["GET"], requiresSession: true },
} as const;

const sessionExemptIds = new Set(Object.entries(PUBLIC_API_READS)
  .filter(([, route]) => !route.requiresSession)
  .map(([id]) => id));

export function requiresPublicApiSession(id: string): boolean {
  return !sessionExemptIds.has(id);
}

const sessionReads = Object.values(PUBLIC_API_READS)
  .filter((route) => route.requiresSession)
  .map((route) => ({
    methods: new Set<string>(route.methods),
    segments: route.path.split("/"),
  }));

export function isSessionRead(path: string, method: string): boolean {
  const segments = path.split("/");
  const readMethod = method === "HEAD" ? "GET" : method;
  return sessionReads.some((route) => route.methods.has(readMethod)
    && route.segments.length === segments.length
    && route.segments.every((part, index) => part.startsWith("[") ? segments[index] !== "" : part === segments[index]));
}

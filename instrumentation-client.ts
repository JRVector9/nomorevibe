import { createSessionFetch } from "@/lib/anti-scrape/client";

// Next runs this before hydration: protect existing and PR A's future fetch callers without changing view components.
window.fetch = createSessionFetch(window.fetch.bind(window), window.location.origin);

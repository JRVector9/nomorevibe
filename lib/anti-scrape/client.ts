import { isSessionRead, PUBLIC_API_READS } from "./paths";

const sessionPath = PUBLIC_API_READS.session.path;

type Turnstile = { render: (element: HTMLElement, options: Record<string, unknown>) => string; remove: (id: string) => void };
declare global { interface Window { turnstile?: Turnstile } }
let script: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return script ??= new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    const timer = setTimeout(() => { element.remove(); reject(new Error("turnstile_timeout")); }, 15_000);
    element.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    element.async = true;
    element.onload = () => { clearTimeout(timer); resolve(); };
    element.onerror = () => { clearTimeout(timer); element.remove(); reject(new Error("turnstile_unavailable")); };
    document.head.append(element);
  }).catch(error => { script = null; throw error; });
}
async function challenge(siteKey: string): Promise<string> {
  await loadScript();
  return new Promise((resolve, reject) => {
    const container = document.createElement("div");
    document.body.append(container);
    let id: string | undefined;
    const finish = (token?: string) => {
      clearTimeout(timer);
      if (id !== undefined) window.turnstile?.remove(id);
      container.remove();
      if (token) resolve(token); else reject(new Error("turnstile_failed"));
    };
    const timer = setTimeout(() => finish(), 20_000);
    try {
      id = window.turnstile!.render(container, { sitekey: siteKey, action: "api-session", callback: (token: string) => finish(token),
        "error-callback": () => { finish(); return true; }, "expired-callback": () => finish(), "response-field": false, retry: "never" });
    } catch { finish(); }
  });
}

/** Coalesce config/challenge/renewal for every concurrent card/detail load. No component or payload coupling. */
export function createSessionFetch(fetcher: typeof fetch, origin: string, solve: (siteKey: string) => Promise<string> = challenge): typeof fetch {
  let expiresAt = 0, nextConfig = 0;
  let mode: "observe" | "enforce" = "observe";
  let pending: Promise<void> | null = null;
  const ensure = (force = false): Promise<void> => {
    if (!force && Date.now() < Math.min(expiresAt - 5_000, nextConfig)) return Promise.resolve();
    if (!force && mode === "observe" && expiresAt === 0 && Date.now() < nextConfig) return Promise.resolve();
    return pending ??= (async () => {
      const response = await fetcher(origin + sessionPath, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("session_config_failed");
      const config = await response.json();
      nextConfig = Date.now() + 30_000;
      if (!config.enabled) { expiresAt = 0; mode = "observe"; return; }
      mode = config.mode;
      if (!force && config.expiresAt > Date.now() + 5_000) { expiresAt = config.expiresAt; return; }
      try {
        const token = await solve(config.siteKey);
        const issued = await fetcher(origin + sessionPath, { method: "POST", cache: "no-store", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
        if (!issued.ok) throw new Error("session_issue_failed");
        expiresAt = (await issued.json()).expiresAt ?? 0;
      } catch (error) {
        expiresAt = 0;
        if (mode === "enforce") throw error;
      }
    })().finally(() => { pending = null; });
  };
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin !== origin) return fetcher(input, init);
    const sessionRead = isSessionRead(url.pathname, method);
    const retryableApiGet = method === "GET" && url.pathname.startsWith("/api/") && url.pathname !== sessionPath;
    if (!sessionRead && !retryableApiGet) return fetcher(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (sessionRead) await ensure();
    // Clone before first send so POST summaries and Request bodies can be retried once.
    const retry = sessionRead && input instanceof Request ? input.clone() : input;
    const response = await fetcher(input, init);
    if (response.status !== 401 || (response.url && new URL(response.url).origin !== origin)
      || (await response.clone().json().catch(() => null))?.error !== "api_session_required") return response;
    signal?.throwIfAborted();
    await ensure(true);
    return fetcher(retry, init);
  };
}

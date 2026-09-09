/** Explicit local-only capability. The local Compose web port must bind loopback. */
export function localCodexEnabled(env: Record<string,string|undefined> = process.env): boolean {
  if (env.ADMIN_LOCAL_LOGIN !== '1' || env.ADMIN_LOCAL_CODEX !== '1') return false;
  try {
    const url = new URL(env.NEXT_PUBLIC_SITE_URL ?? '');
    return url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch { return false; }
}

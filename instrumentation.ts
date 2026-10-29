export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // The admin engine check (and any model call from the web) reaches engines addressed by Tailscale names.
  (await import('./lib/net/tailnet-dns')).installTailnetDns();
  const { startWebObserver } = await import('./lib/operations/web-observer');
  startWebObserver();
}

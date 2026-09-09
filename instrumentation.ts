export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startWebObserver } = await import('./lib/operations/web-observer');
  startWebObserver();
}

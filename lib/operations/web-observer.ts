import { observeService } from './observations';

const globalObserver = globalThis as typeof globalThis & {
  noMoreVibeWebObserver?: ReturnType<typeof setInterval>;
};

export function startWebObserver(): void {
  if (globalObserver.noMoreVibeWebObserver) return;
  const bootedAt = Date.now();
  let pending = false;
  const publish = () => {
    if (pending) return;
    pending = true;
    void observeService('app', {
      status: 'running',
      pid: process.pid,
      bootedAt,
      release: process.env.RELEASE_TAG ?? process.env.NEXT_DEPLOYMENT_ID ?? 'unknown',
      rssBytes: process.memoryUsage().rss,
    }).catch(() => {}).finally(() => { pending = false; });
  };
  publish();
  globalObserver.noMoreVibeWebObserver = setInterval(publish, 15_000);
  globalObserver.noMoreVibeWebObserver.unref();
}

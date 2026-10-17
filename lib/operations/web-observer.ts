import { webWritable } from './dr/web-gate';
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
    // fenced DB 에는 생존 관측도 쓰지 않는다(캐시 관문만)
    void webWritable().then(writable => writable ? observeService('app', {
      status: 'running',
      pid: process.pid,
      bootedAt,
      release: process.env.RELEASE_TAG ?? process.env.NEXT_DEPLOYMENT_ID ?? 'unknown',
      rssBytes: process.memoryUsage().rss,
    }) : undefined).catch(() => {}).finally(() => { pending = false; });
  };
  publish();
  globalObserver.noMoreVibeWebObserver = setInterval(publish, 15_000);
  globalObserver.noMoreVibeWebObserver.unref();
}

'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 운영센터를 스스로 다시 읽는다.
 *
 * 이 화면의 숫자는 전부 서버 컴포넌트가 한 번 그린 값이라, 열어 둔 채로는 몇 분이 지나도
 * 그대로였다 — 워커는 15초마다 관측을 남기고 잡은 1분마다 도는데 화면만 멈춰 있었다.
 * 조회가 0.6초로 줄어든 뒤에야 주기적으로 다시 읽는 것이 감당할 만해졌다.
 *
 * 보이지 않는 탭에서는 쉰다. 눈에 안 보이는 화면 때문에 프로드 DB를 두드릴 이유가 없다.
 * 창으로 돌아오면 곧바로 한 번 읽어 묵은 숫자를 보여주지 않는다.
 */
const INTERVAL_MS = 10_000;

export function LiveRefresh() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [live, setLive] = useState(true);
  // 새로 읽는 동안 또 부르지 않는다 — 느린 응답이 겹치면 요청만 쌓인다
  const busy = useRef(false);

  useEffect(() => {
    if (!live) return;
    const refresh = () => {
      if (busy.current || document.visibilityState !== 'visible') return;
      busy.current = true;
      start(() => { router.refresh(); });
    };
    const timer = setInterval(refresh, INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [live, router]);

  useEffect(() => { if (!pending) busy.current = false; }, [pending]);

  return (
    <button type="button" onClick={() => setLive(!live)} aria-pressed={live}
      title={live ? `${INTERVAL_MS / 1000}초마다 다시 읽습니다. 눌러서 멈춥니다.` : '멈춰 있습니다. 눌러서 다시 읽습니다.'}>
      <span aria-hidden className={live ? 'ops-live-dot on' : 'ops-live-dot'} />
      {live ? (pending ? '읽는 중' : '실시간') : '멈춤'}
    </button>
  );
}

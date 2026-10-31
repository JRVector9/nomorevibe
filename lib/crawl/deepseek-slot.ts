let tail: Promise<void> = Promise.resolve();

/**
 * M3 로컬 DeepSeek 을 부르는 두 쪽 — 사람 큐 위임(jobs/human-review.ts)과 2차 갈림 판가름의 DeepSeek 확인(gate-split-confirm.ts) — 이
 * 프로세스에서 나눠 쓰는 한 자리. 2026-10-31(PR 3a-C) 전에는 둘이 한 잡(human-deepseek-review) 안에서 차례로 돌아 잡 lease 가 M3 호출을
 * 하나로 줄 세웠다. 이제 둘은 자기 줄에서 따로 틱을 돌므로(human·confirm) 호출만 이 자리로 줄 세운다 — 앞 호출이 끝날 때까지 기다린 뒤
 * run 을 돌린다. run 은 자리를 얻은 뒤 남은 예산·마감을 다시 봐야 한다(기다리는 동안 바뀐다). 틱 자체는 기다리지 않는다: 한 쪽이 60초 호출을
 * 붙잡아도 다른 쪽은 claim·기록을 이어 가고 호출 차례만 기다린다. 모양은 gpu3090 의 두 번째 자리(qwen-endpoint-backoff.ts withQwenSecondarySlot)와 같다.
 * 공통 장부(local-direct route 의 물리 한도)가 open 이면 그 한도가 함께 걸린다 — 이 자리는 장부가 disabled 일 때도 지키는 프로세스 안의 하한이다.
 */
export async function withDeepSeekSlot<T>(run: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    return await run();
  } finally {
    release();
  }
}

'use client';

import { useCallback, useRef, useState } from 'react';
import type { PolicyRunProgress } from '@/lib/crawl/audit-policy';
import { applyPolicyChunkAction, undoPolicyChunkAction } from './policy-actions';

/**
 * 정책 실행을 끝날 때까지 나눠 부른다 — 한 번에 몇십 건(서버 POLICY_CHUNK·8초)이라 긴 요청이 끊겨 반만 적용된 채 숨지 않는다.
 * Cloudflare 지우기 줄이 밀리면(waiting) 그만큼 기다렸다 다시 부른다. 요청이 끊기거나 창을 닫으면 멈추고, 실행은 서버에 '적용 중'으로 남아
 * 실행 목록의 '이어서 적용'이 남은 것부터 잇는다. 사람이 '멈춤'을 누르면 지금 묶음이 끝난 뒤 멈춘다.
 */
export function usePolicyRunLoop() {
  const [progress, setProgress] = useState<PolicyRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const stop = useRef(false);

  const loop = useCallback(async (runId: number, mode: 'apply' | 'undo') => {
    stop.current = false;
    setRunning(true);
    setError(null);
    try {
      for (let calls = 0; calls < 5_000; calls++) {
        if (stop.current) break;
        const result = mode === 'apply' ? await applyPolicyChunkAction(runId) : await undoPolicyChunkAction(runId);
        if (!result.ok) { setError(result.error); break; }
        setProgress(result.value);
        if (result.value.done) break;
        if (result.value.waiting) {
          setWaiting(`Cloudflare 지우기 줄이 밀려 ${Math.round(result.value.waiting.retryMs / 1000)}초 기다립니다 — 차단·내려달라는 요청의 지우기를 밀어내지 않게`);
          await new Promise((resolve) => setTimeout(resolve, result.value.waiting!.retryMs));
          setWaiting(null);
        }
      }
    } catch {
      setError('요청이 끊겼습니다. 실행 목록의 «이어서»를 누르면 남은 것부터 잇습니다 — 이미 한 것은 다시 하지 않습니다.');
    } finally {
      setRunning(false);
      setWaiting(null);
    }
  }, []);

  return { progress, setProgress, error, running, waiting, loop, stop: () => { stop.current = true; } };
}

/** 진행 막대 한 줄의 글자 */
export function progressText(progress: PolicyRunProgress): string {
  const n = (value: number) => value.toLocaleString('ko-KR');
  if (progress.status === 'undoing' || progress.status === 'undone') {
    return `되돌림 ${n(progress.undone)} · 되돌리지 못함 ${n(progress.blocked)} · 남은 것 ${n(progress.applied)}${progress.cancelled ? ` · 적용 취소 ${n(progress.cancelled)}` : ''}`;
  }
  return `적용 ${n(progress.applied)} · 건너뜀 ${n(progress.skipped)} · 남은 것 ${n(progress.pending)} / ${n(progress.planned)}`;
}

export function progressRatio(progress: PolicyRunProgress): number {
  if (progress.status === 'undoing' || progress.status === 'undone') {
    const total = progress.undone + progress.blocked + progress.applied;
    return total ? (progress.undone + progress.blocked) / total : 1;
  }
  return progress.planned ? (progress.planned - progress.pending) / progress.planned : 1;
}

'use client';

import { useSyncExternalStore } from 'react';
import { needsKorean } from '@/lib/crawl/korean';

/**
 * 사유를 한글·원문 중 무엇으로 볼지 — 화면 하나의 설정을 모든 사유가 따른다.
 * 브라우저에만 둔다(관리자마다 다를 수 있다). 기본은 한글이다.
 */
type Lang = 'ko' | 'original';
const KEY = 'nmv.reasonLang';
const listeners = new Set<() => void>();

function read(): Lang {
  try { return localStorage.getItem(KEY) === 'original' ? 'original' : 'ko'; } catch { return 'ko'; }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
function choose(lang: Lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* 저장이 막혀도 이번 화면에서는 바뀐다 */ }
  listeners.forEach((listener) => listener());
}
function useReasonLang(): Lang {
  return useSyncExternalStore(subscribe, read, () => 'ko');
}

/** 사유 한 줄. 한글로 볼 때 번역이 아직 없으면 원문과 함께 "번역 대기"를 단다 */
export function ReasonText({ text, korean, limit }: { text: string | null; korean?: string | null; limit?: number }) {
  const lang = useReasonLang();
  if (!text) return null;
  const shown = lang === 'ko' && korean ? korean : text;
  const waiting = lang === 'ko' && !korean && needsKorean(text);
  return <>
    {limit ? shown.slice(0, limit) : shown}
    {waiting && <span className="ml-1.5 whitespace-nowrap rounded bg-bg-soft px-1.5 py-px text-[13px] text-fg-3">번역 대기</span>}
  </>;
}

export function ReasonLanguageToggle({ done, total }: { done: number; total: number }) {
  const lang = useReasonLang();
  const option = (value: Lang, label: string) => (
    <button type="button" aria-pressed={lang === value} onClick={() => choose(value)}
      className={`px-2.5 py-1 ${lang === value ? 'bg-accent-soft font-semibold text-accent' : 'text-fg-2 hover:bg-bg-hover'}`}>{label}</button>
  );
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <div role="group" aria-label="사유 표시 언어" className="flex overflow-hidden rounded-full border border-line bg-bg-card">
        {option('ko', '한글')}{option('original', '원문')}
      </div>
      <span className="font-mono text-[13px] text-fg-3" title="영어 사유를 미리 한국어로 옮겨 둡니다 (gpt-oss-120b)">
        번역 {done.toLocaleString('ko-KR')}/{total.toLocaleString('ko-KR')}
      </span>
    </div>
  );
}

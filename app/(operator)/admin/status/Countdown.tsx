'use client';
import { useEffect, useState } from 'react';
import { remainingSeconds } from '@/lib/operations/countdown';
export function Countdown({deadlineAt,serverNow,label}:{deadlineAt:number;serverNow:number;label:string}) {
  const [seconds,setSeconds]=useState(()=>remainingSeconds(deadlineAt,serverNow));
  useEffect(()=>{
    const receivedAt=performance.now();
    const tick=()=>setSeconds(remainingSeconds(deadlineAt,serverNow,performance.now()-receivedAt));
    const initial=setTimeout(tick,0),timer=setInterval(tick,250);
    return()=>{clearTimeout(initial);clearInterval(timer);};
  },[deadlineAt,serverNow]);
  return <div className="ai-countdown" role="timer" aria-label={label}>
    <span>{label}</span><strong>{seconds>0?`${seconds}초 남음`:'기한 종료 · 서버 결과 확인 중'}</strong>
  </div>;
}

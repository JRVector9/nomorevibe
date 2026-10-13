'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { codexOperation } from './actions';
import type { AgentStatus } from '@/lib/operations/contracts';

/** Poll while this tab is mounted; failed polls never erase the last known state. */
export function useAgentConnection(initial: AgentStatus | null) {
  const [status,setStatus]=useState(initial),[pending,setPending]=useState(false);
  const [transportError,setTransportError]=useState(''),[message,setMessage]=useState(''),[checkedAt,setCheckedAt]=useState<string|null>(null);
  const mounted=useRef(false),reading=useRef(false),mutating=useRef(false),revision=useRef(0);
  const refresh=useCallback(async()=>{
    if(reading.current||mutating.current)return;
    reading.current=true;const version=revision.current;
    try{
      const result=await codexOperation('status');
      if(!mounted.current||version!==revision.current)return;
      if(result.error){setTransportError(result.error);return;}
      if(result.status){setStatus(result.status);setCheckedAt(new Date().toISOString());setTransportError('');}
    }catch{if(mounted.current&&version===revision.current)setTransportError('연결 서비스에 응답을 받지 못했습니다. 자동으로 다시 확인합니다.');}
    finally{reading.current=false;}
  },[]);
  useEffect(()=>{
    mounted.current=true;const initialRead=setTimeout(()=>void refresh(),0);
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},3000);
    const focus=()=>void refresh();window.addEventListener('focus',focus);
    return()=>{mounted.current=false;clearTimeout(initialRead);clearInterval(timer);window.removeEventListener('focus',focus);};
  },[refresh]);
  const perform=async(action:string,data:Record<string,unknown>={})=>{
    if(mutating.current)return {error:'요청을 처리하고 있습니다.'};
    mutating.current=true;revision.current++;setPending(true);setMessage('');
    try{
      const result=await codexOperation(action,data);
      if(!mounted.current)return result;
      if(result.error){setMessage(result.error);return result;}
      if(result.status){setStatus(result.status);setCheckedAt(new Date().toISOString());setTransportError('');}
      if(action==='apply')setMessage('모델 설정을 적용했습니다. 다음 분류 배치부터 사용합니다.');
      return result;
    }catch{const error='요청을 전달하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해주세요.';if(mounted.current)setMessage(error);return {error};}
    finally{mutating.current=false;if(mounted.current)setPending(false);}
  };
  return {status,pending,transportError,message,checkedAt,refresh,perform};
}

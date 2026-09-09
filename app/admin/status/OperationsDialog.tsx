'use client';
import { useEffect, useRef } from 'react';
export function OperationsDialog({labelledBy,onClose,children}:{labelledBy:string;onClose:()=>void;children:React.ReactNode}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const el=ref.current;el?.showModal();return ()=>el?.close();},[]);
  return <dialog ref={ref} className="ops-modal" aria-labelledby={labelledBy} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}>{children}</dialog>;
}

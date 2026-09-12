'use client';
import {useOptimistic,useTransition} from 'react';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
export function PopularFilter({personal}:{personal:boolean}){
 const router=useRouter(),pathname=usePathname(),params=useSearchParams();
 const [pending,startTransition]=useTransition();
 const [checked,setChecked]=useOptimistic(personal);
 return <label className="popular-filter" aria-busy={pending}><input type="checkbox" checked={checked} onChange={event=>{
  const selected=event.target.checked;
  const next=new URLSearchParams(params.toString());
  if(event.target.checked)next.set('personal','1');else next.delete('personal');
  next.delete('page');
  startTransition(()=>{
   setChecked(selected);
   router.push(`${pathname}?${next}${pathname==='/'?'#popular-projects':''}`,{scroll:false});
  });
 }}/><span>개인 계정만</span></label>;
}

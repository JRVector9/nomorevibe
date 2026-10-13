'use client';
import {useTranslations} from '@/lib/i18n/context';
import {stripLocale} from '@/lib/i18n/routing';
import {useOptimistic,useTransition} from 'react';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
export function PopularFilter({personal}:{personal:boolean}){
 const t=useTranslations("browse");
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
   router.push(`${pathname}?${next}${stripLocale(pathname)==='/'?'#popular':''}`,{scroll:false});
  });
 }}/><span>{t("popular.personal")}</span></label>;
}

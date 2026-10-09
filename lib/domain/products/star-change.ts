export type StarObservation={stars?:number|null;starsAt?:Date|string|null;starsPrevious?:number|null;starsPreviousAt?:Date|string|null};
const time=(value:Date|string|null|undefined)=>{
 if(!value)return NaN;
 // PostgreSQL timestamp columns are UTC; their ::text form omits the zone.
 const normalized=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}[ T]/.test(value)&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)?value.replace(' ','T')+'Z':value;
 return new Date(normalized).getTime();
};
export function starChange(value:StarObservation):number|null{
 if(!Number.isSafeInteger(value.stars)||!Number.isSafeInteger(value.starsPrevious)||value.stars!<0||value.starsPrevious!<0)return null;
 const at=time(value.starsAt),before=time(value.starsPreviousAt);
 return Number.isFinite(at)&&Number.isFinite(before)&&before<at?value.stars!-value.starsPrevious!:null;
}
/** 확인한 날 — 한국 날짜(YYYY-MM-DD). UTC 텍스트의 앞 10자를 자르면 15시(UTC) 뒤의 확인이 하루 이르게 적힌다 */
export function starObservationDay(value:Date|string|null|undefined):string|null{
 const at=time(value);return Number.isFinite(at)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)):null;
}

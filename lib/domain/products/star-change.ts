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
export function starObservationLabel(value:Date|string|null|undefined){
 const at=time(value);return Number.isFinite(at)?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(at)):'확인 전';
}

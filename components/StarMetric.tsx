import{starChange,starObservationLabel,type StarObservation}from'@/lib/domain/products/star-change';
export function StarMetric({value,compact=false}:{value:StarObservation;compact?:boolean}){
 if(value.stars===null||value.stars===undefined)return null;
 const delta=starChange(value),label=delta===null?(compact?'—':'비교 수집 중'):delta>0?`+${delta.toLocaleString('ko-KR')}`:delta<0?`−${Math.abs(delta).toLocaleString('ko-KR')}`:'±0';
 const detail=delta===null?'이전 측정값 수집 중':`이전 측정 대비 ${label} (${starObservationLabel(value.starsPreviousAt)} → ${starObservationLabel(value.starsAt)})`;
 return <span className="star-metric" title={`GitHub 스타 · ${starObservationLabel(value.starsAt)} 확인 · ${detail}`}>
  <span aria-label={`스타 ${value.stars.toLocaleString('ko-KR')}개`}>★ {value.stars.toLocaleString('ko-KR')}</span>
  <small className={delta!==null&&delta>0?'star-change-up':delta!==null&&delta<0?'star-change-down':'star-change-neutral'} aria-label={detail}>{label}</small>
 </span>;
}

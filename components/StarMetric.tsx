import { starChange, type StarObservation } from '@/lib/domain/products/star-change';
import { formatCount } from '@/lib/format/number';
import { formatPublicDate, formatPublicDateTime, toDate, type TimeInput } from '@/lib/format/time';

/** 스타 0인 카드에 '새 프로젝트'를 붙이는 기간 — 등록한 지 이만큼 안이면 새로 올라온 것이다 */
const NEW_PROJECT_DAYS = 30;

/**
 * 스타 수와 직전 확인 대비 증감. 증감이 0이면 적지 않는다('±0'은 멈춘 것처럼 읽힌다 — UX-29).
 * 스타 0은 별을 숨긴다 — 등록 시각(listedAt)을 넘기면 최근 등록이면 '새 프로젝트'를 대신 보인다.
 * now 는 서버가 읽은 시각을 넘긴다(없으면 지금).
 */
export function StarMetric({ value, now = new Date(), listedAt }: { value: StarObservation; now?: Date | string | number; listedAt?: TimeInput }) {
  if (value.stars === null || value.stars === undefined) return null;
  if (value.stars === 0) {
    const listed = toDate(listedAt);
    const base = toDate(now);
    const recent = listed && base && base.getTime() - listed.getTime() <= NEW_PROJECT_DAYS * 86_400_000;
    return recent ? <span className="star-metric" title={`${formatPublicDate(listed, base)} 등록`}>새 프로젝트</span> : null;
  }
  const delta = starChange(value);
  const label = !delta ? null : delta > 0 ? `+${formatCount(delta)}` : `−${formatCount(Math.abs(delta))}`;
  const detail = label === null ? '' : `이전 측정 대비 ${label} (${formatPublicDateTime(value.starsPreviousAt, now, '확인 전')} → ${formatPublicDateTime(value.starsAt, now, '확인 전')})`;
  const measured = value.starsAt ? ` · ${formatPublicDateTime(value.starsAt, now, '확인 전')}` : '';
  return <span className="star-metric" title={`GitHub 스타${measured}${detail ? ` · ${detail}` : ''}`}>
    <span aria-label={`스타 ${formatCount(value.stars)}개`}>★ {formatCount(value.stars)}</span>
    {label !== null && <small className={delta! > 0 ? 'star-change-up' : 'star-change-down'} aria-label={detail}>{label}</small>}
  </span>;
}

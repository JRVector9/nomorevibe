import{it,expect}from'vitest';import{starChange,starObservationDay,starObservationLabel}from'@/lib/domain/products/star-change';
it('shows signed changes only for two real ordered observations',()=>{
 const base={starsAt:'2026-09-13T12:00:00Z',starsPreviousAt:'2026-09-12T12:00:00Z',starsPrevious:100};
 expect(starChange({...base,stars:105})).toBe(5);expect(starChange({...base,stars:97})).toBe(-3);expect(starChange({...base,stars:100})).toBe(0);
 expect(starChange({stars:100})).toBeNull();expect(starChange({...base,stars:100,starsPreviousAt:base.starsAt})).toBeNull();expect(starChange({...base,stars:100,starsPrevious:null})).toBeNull();
});

it('interprets PostgreSQL timestamp text as UTC for Korean display',()=>{expect(starObservationLabel('2026-09-13 13:00:00')).toBe(starObservationLabel('2026-09-13T13:00:00Z'));});

it('dates a UTC observation by its Korean calendar day',()=>{
 // 15:00 UTC 뒤의 확인은 한국에서는 다음 날이다 — 텍스트 앞 10자를 자르면 하루 이르게 적힌다
 expect(starObservationDay('2026-10-07 20:15:00.123456')).toBe('2026-10-08');
 expect(starObservationDay('2026-10-07 14:59:59')).toBe('2026-10-07');
 expect(starObservationDay(null)).toBeNull();
});

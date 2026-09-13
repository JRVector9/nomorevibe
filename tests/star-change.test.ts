import{it,expect}from'vitest';import{starChange,starObservationLabel}from'@/lib/domain/products/star-change';
it('shows signed changes only for two real ordered observations',()=>{
 const base={starsAt:'2026-09-13T12:00:00Z',starsPreviousAt:'2026-09-12T12:00:00Z',starsPrevious:100};
 expect(starChange({...base,stars:105})).toBe(5);expect(starChange({...base,stars:97})).toBe(-3);expect(starChange({...base,stars:100})).toBe(0);
 expect(starChange({stars:100})).toBeNull();expect(starChange({...base,stars:100,starsPreviousAt:base.starsAt})).toBeNull();expect(starChange({...base,stars:100,starsPrevious:null})).toBeNull();
});

it('interprets PostgreSQL timestamp text as UTC for Korean display',()=>{expect(starObservationLabel('2026-09-13 13:00:00')).toBe(starObservationLabel('2026-09-13T13:00:00Z'));});

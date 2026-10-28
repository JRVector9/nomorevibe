import {expect,it} from 'vitest';
import {firstKoreanCursor,koreanSearchQuery,nextKoreanCursor} from '@/lib/crawl/korean-discovery/contracts';
const now=new Date('2026-10-28T00:00:00Z');
const cursor=firstKoreanCursor(new Date('2026-10-01T00:00:00Z'),3,now);
it('fixes explicit historical start and advances all pages before moving a window',()=>{
  expect(cursor.window).toEqual({from:'2026-10-01T00:00:00Z',to:'2026-10-04T00:00:00Z'});
  const second=nextKoreanCursor(cursor,{length:100,total:150},3,now);expect(second.page).toBe(2);expect(second.window).toEqual(cursor.window);
  const next=nextKoreanCursor(second,{length:50,total:150},3,now);expect(next.window.from).toBe('2026-10-04T00:00:01Z');
});
it('splits saturated or incomplete windows and retains an unsplittable unresolved interval',()=>{
  const split=nextKoreanCursor(cursor,{length:100,total:1001},3,now);expect(split.pendingWindows).toHaveLength(1);expect(split.window.to<cursor.window.to).toBe(true);
  const tiny={...cursor,window:{from:'2026-10-01T00:00:00Z',to:'2026-10-01T00:00:00Z'}};
  expect(nextKoreanCursor(tiny,{length:0,incomplete:true},3,now)).toMatchObject({window:tiny.window,unresolved:true});
});
it('continues split sibling windows and only public visibility with a fixed pushed interval',()=>{
  const split=nextKoreanCursor(cursor,{length:100,total:1001},3,now);
  expect(nextKoreanCursor(split,{length:0},3,now).window).toEqual(split.pendingWindows[0]);
  expect(koreanSearchQuery('있습니다 in:readme',cursor.window)).toBe('있습니다 in:readme is:public pushed:2026-10-01T00:00:00Z..2026-10-04T00:00:00Z');
});

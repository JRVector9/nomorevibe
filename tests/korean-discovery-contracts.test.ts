import {expect,it} from 'vitest';
import {desiredKoreanQueries,firstKoreanCursor,koreanSearchQuery,nextKoreanCursor,resumeKoreanCursor} from '@/lib/crawl/korean-discovery/contracts';
import {DEFAULT_CRAWL_SETTINGS} from '@/lib/crawl/settings-schema';
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

it('visits every accessible saturated minimal-window page and recovers after a complete retry',()=>{
  let current: import("@/lib/crawl/korean-discovery/contracts").KoreanCursor={...cursor,window:{from:'2026-10-01T00:00:00Z',to:'2026-10-01T00:00:00Z'}};
  for(let page=1;page<=10;page++) {
    expect(current.page).toBe(page);
    current=nextKoreanCursor(current,{length:100,total:1001,incomplete:true},3,now);
  }
  expect(current).toMatchObject({page:1,unresolved:true,waitingUntil:expect.any(String)});
  const retry=resumeKoreanCursor(current,3,new Date(Date.parse(current.waitingUntil!)+1));
  expect(retry.window).toEqual(current.window);expect(retry.unresolved).toBeUndefined();
  const recovered=nextKoreanCursor(retry,{length:1,total:1},3,now);
  expect(recovered.unresolved).toBeUndefined();expect(recovered.window.from).toBe('2026-10-01T00:00:01Z');
});

it('derives canonical desired queries before rows exist, preserving configured additions and explicit query disables',()=>{
  const configured=[{label:'추가',query:'한국어 in:readme',priority:50},{label:'중복',query:'  있습니다   in:readme ',priority:40},
    {label:'꺼짐',query:'합니다 in:readme',priority:40}];
  const settings={...DEFAULT_CRAWL_SETTINGS,discover:{...DEFAULT_CRAWL_SETTINGS.discover,queries:[
    {label:'기존',query:'있습니다 in:readme',kind:'repositories' as const,priority:60,enabled:true,builder:null},
    {label:'끄기',query:'합니다 in:readme',kind:'repositories' as const,priority:50,enabled:false,builder:null},
    {label:'영문',query:'topic:vibe',kind:'repositories' as const,priority:50,enabled:true,builder:null}]}};
  expect(desiredKoreanQueries(settings,configured)).toEqual([
    {label:'기존',query:'있습니다 in:readme',priority:60},{label:'추가',query:'한국어 in:readme',priority:50}]);
});

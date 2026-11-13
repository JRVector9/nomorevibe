import {expect,it} from 'vitest';
import {firstKoreanCursor,isKoreanRepositoryQuery,koreanSearchQuery,m3DiscoveryQueries,nextKoreanCursor,resumeKoreanCursor} from '@/lib/crawl/korean-discovery/contracts';
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
it('keeps every Korean-only repository search off M3, whether Oracle is on or off',()=>{
  const queries=[
    {label:'한국어 README (AI 흔적 필요)',kind:'repositories' as const,query:'있습니다 in:readme',enabled:true},
    {label:'바이브코딩 (한국어 README)',kind:'repositories' as const,query:'바이브코딩 in:name,description,readme',enabled:false},
    {label:'Claude 커밋 트레일러',kind:'commits' as const,query:'Co-authored-by: Claude',enabled:true},
    {label:'vibe-coding 토픽',kind:'repositories' as const,query:'topic:vibe-coding',enabled:true},
    // A Korean label alone does not make an English search Korean-only.
    {label:'한글 라벨',kind:'repositories' as const,query:'topic:cursor-ai',enabled:true},
  ];
  expect(m3DiscoveryQueries(queries).map(q=>q.label)).toEqual(['Claude 커밋 트레일러','vibe-coding 토픽','한글 라벨']);
  expect(isKoreanRepositoryQuery({kind:'commits',query:'커밋 한국어'})).toBe(false);
});

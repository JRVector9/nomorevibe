import { expect, it } from 'vitest';
import { parseRepositoryStats, starTier, parsePopularParams, popularHref, popularStateHref } from '@/lib/domain/products/stars';
it('구간 경계를 겹치지 않고 10만 이상을 제외한다', () => {
  expect([1999,2000,4999,5000,9999,10000,29999,30000,99999,100000].map(starTier))
    .toEqual([null,'rising','rising','noticed','noticed','popular','popular','large','large',null]);
});
it('GitHub 숫자와 계정 종류를 검증하며 문자열·음수·추정값을 쓰지 않는다', () => {
  expect(parseRepositoryStats({stargazers_count:5000,owner:{type:'User'}})).toEqual({stars:5000,ownerType:'User'});
  expect(parseRepositoryStats({stargazers_count:0,owner:{type:'Organization'}})).toEqual({stars:0,ownerType:'Organization'});
  for (const v of ['5000',-1,NaN,1.5,2147483648,null]) expect(parseRepositoryStats({stargazers_count:v})).toBeNull();
  expect(parseRepositoryStats({stargazers_count:2,owner:{type:'unknown'}})?.ownerType).toBeNull();
});
it('공개 URL 상태를 검증하고 중복 파라미터는 첫 값만 읽는다', () => {
  expect(parsePopularParams({tier:['large','rising'],personal:'1',page:'2'})).toEqual({tier:'large',personal:true,ai:false,category:null,sort:'stars',view:'list',page:2});
  expect(parsePopularParams({tier:'bad',personal:'true',page:'-2'})).toEqual({tier:'rising',personal:false,ai:false,category:null,sort:'stars',view:'list',page:1});
});
it('/popular 거르기·정렬·보기는 홈과 같은 주소 말(ai=made, 소문자 분야)로 읽고, 모르는 값은 기본으로 둔다', () => {
  expect(parsePopularParams({tier:'noticed',ai:'made',category:' DATA ',sort:'rising',view:'cards'}))
    .toEqual({tier:'noticed',personal:false,ai:true,category:'Data',sort:'rising',view:'cards',page:1});
  expect(parsePopularParams({ai:'1',category:'nope',sort:'hot',view:'table'}))
    .toEqual({tier:'rising',personal:false,ai:false,category:null,sort:'stars',view:'list',page:1});
});
it('거르기·정렬·구간을 바꾸면 첫 쪽으로 가고, 보기만 바꾸면 쪽을 지킨다', () => {
  const state=parsePopularParams({tier:'popular',personal:'1',ai:'made',category:'data',sort:'rising',view:'cards',page:'3'});
  expect(popularStateHref(state)).toBe('/popular?tier=popular&personal=1&ai=made&category=data&sort=rising&view=cards&page=3');
  expect(popularStateHref(state,{category:null})).toBe('/popular?tier=popular&personal=1&ai=made&sort=rising&view=cards');
  expect(popularStateHref(state,{tier:'large'})).toBe('/popular?tier=large&personal=1&ai=made&category=data&sort=rising&view=cards');
  expect(popularStateHref(state,{view:'list'})).toBe('/popular?tier=popular&personal=1&ai=made&category=data&sort=rising&page=3');
  expect(popularStateHref(state,{page:4})).toContain('page=4');
  expect(popularHref('noticed',true,2)).toBe('/popular?tier=noticed&personal=1&page=2');
});

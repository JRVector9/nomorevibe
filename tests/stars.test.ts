import { expect, it } from 'vitest';
import { parseRepositoryStats, starTier, parsePopularParams } from '@/lib/domain/products/stars';
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
  expect(parsePopularParams({tier:['large','rising'],personal:'1',page:'2'})).toEqual({tier:'large',personal:true,page:2});
  expect(parsePopularParams({tier:'bad',personal:'true',page:'-2'})).toEqual({tier:'rising',personal:false,page:1});
});

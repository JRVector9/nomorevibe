import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({settings:vi.fn(),enabled:vi.fn(),claim:vi.fn(),defer:vi.fn(),stage:vi.fn(),batch:vi.fn(),save:vi.fn(),inspect:vi.fn(),
  shared:vi.fn(),search:vi.fn(),progress:vi.fn(),observe:vi.fn(),reuse:vi.fn()}));
vi.mock('@/lib/crawl/settings',()=>({getSettings:mocks.settings}));
vi.mock('@/lib/crawl/shared-discovery',()=>({sharedDiscoverySearch:mocks.shared}));
vi.mock('@/lib/crawl/github',()=>({searchRepositories:mocks.search}));
vi.mock('@/lib/crawl/discovery-progress',()=>({recordDiscoveryProgress:mocks.progress}));
vi.mock('@/lib/operations/observations',()=>({observe:mocks.observe}));
vi.mock('@/lib/crawl/korean-discovery/repository',()=>({claimKoreanQuery:mocks.claim,deferKoreanQuery:mocks.defer,stageKoreanPage:mocks.stage,
  koreanLanguageBatch:mocks.batch,saveKoreanLanguage:mocks.save,koreanDiscoveryEnabled:mocks.enabled,importSharedKoreanCandidates:mocks.reuse}));
vi.mock('@/lib/crawl/korean-discovery/language',()=>({inspectKoreanProject:mocks.inspect}));
const {koreanDiscoveryTick}=await import('@/lib/crawl/korean-discovery/consumer');
const window={from:'2026-10-01T00:00:00Z',to:'2026-10-04T00:00:00Z'};
const claim={label:'한글',query:'있습니다 in:readme',priority:60,token:'token',epoch:1,controlEpoch:1,cursor:{window,page:1,pendingWindows:[]},windowDays:3};
beforeEach(()=>{
  vi.resetAllMocks();mocks.settings.mockResolvedValue({enabled:true,discover:{windowDays:3}});mocks.enabled.mockResolvedValue(true);
  mocks.claim.mockResolvedValue(claim);mocks.batch.mockResolvedValue([]);mocks.stage.mockResolvedValue(true);
  mocks.shared.mockImplementation(async (_input,load)=>load());mocks.search.mockResolvedValue({ok:true,value:{items:[]}});
});
it('does not claim, reuse pages, inspect documents or call GitHub while control is disabled',async()=>{
  mocks.enabled.mockResolvedValue(false);expect(await koreanDiscoveryTick({instanceId:'github-ko-discovery-consumer-test'})).toEqual({state:'idle',searched:0,checked:0});
  expect(mocks.claim).not.toHaveBeenCalled();expect(mocks.reuse).not.toHaveBeenCalled();expect(mocks.inspect).not.toHaveBeenCalled();expect(mocks.shared).not.toHaveBeenCalled();
});
it('handles redacted null placeholders and stages a public page before saving the next cursor',async()=>{
  mocks.search.mockResolvedValue({ok:true,value:{items:[null,{full_name:'A/B',description:'한국어 소개'},{full_name:'a/b',description:'한국어 소개'}],total_count:3}});
  await koreanDiscoveryTick({instanceId:'github-ko-discovery-consumer-test'});
  expect(mocks.shared).toHaveBeenCalledWith(expect.objectContaining({scope:'public-v1',ownerName:'github-ko-discovery-consumer-test',query:expect.stringContaining('is:public pushed:')}),expect.any(Function));
  expect(mocks.stage).toHaveBeenCalledWith(claim,[{repo:'a/b',description:'한국어 소개',signal:'한글',priority:60}],expect.objectContaining({page:1}));
  expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({counts:expect.objectContaining({searchRequests:1,returned:3,examined:1})}));
});
it('reuses completed pages without another search and retains unknown language results for retry',async()=>{
  mocks.shared.mockResolvedValue({ok:true,value:{items:[]},cached:true});
  mocks.batch.mockResolvedValue([{repo:'a/unknown',description:null,signal:'한글'}]);
  const unknown={language:'unknown',source:null,contentHash:null,hangul:0,reason:'document_unavailable'};mocks.inspect.mockResolvedValue(unknown);
  const result=await koreanDiscoveryTick({instanceId:'github-ko-discovery-consumer-test'});
  expect(result).toMatchObject({searched:0,checked:1});expect(mocks.search).not.toHaveBeenCalled();expect(mocks.save).toHaveBeenCalledWith('a/unknown',unknown);
  expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({counts:{koreanYes:0,koreanNo:0,koreanUnknown:1}}));
});
it('honors a shared auth reset and never advances a page on search failure or lost staging ownership',async()=>{
  const resetAt=new Date(Date.now()+60000);mocks.shared.mockResolvedValue({ok:false,error:{kind:'rate_limited',resetAt}});
  await koreanDiscoveryTick({instanceId:'github-ko-discovery-consumer-test'});expect(mocks.defer).toHaveBeenCalledWith(claim,resetAt,'rate_limited');expect(mocks.stage).not.toHaveBeenCalled();
  mocks.shared.mockResolvedValue({ok:true,value:{items:[]}});mocks.stage.mockResolvedValue(false);
  await koreanDiscoveryTick({instanceId:'github-ko-discovery-consumer-test'});expect(mocks.defer).toHaveBeenLastCalledWith(claim,expect.any(Date),'staging_capacity_or_lease');
});

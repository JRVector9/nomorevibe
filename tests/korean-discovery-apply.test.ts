import {beforeEach,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const mocks=vi.hoisted(()=>({settings:vi.fn(),sync:vi.fn(),execute:vi.fn(),txExecute:vi.fn(),admit:vi.fn(),fence:vi.fn(),lease:vi.fn(),progress:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{execute:mocks.execute,transaction:async (fn:(tx:unknown)=>unknown)=>fn({execute:mocks.txExecute})}}));
vi.mock('@/lib/crawl/settings',()=>({getSettings:mocks.settings}));
vi.mock('@/lib/crawl/shared-discovery',()=>({enqueueDiscoveryBatch:mocks.admit}));
vi.mock('@/lib/crawl/discovery-progress',()=>({recordDiscoveryProgress:mocks.progress}));
vi.mock('@/lib/jobs/control',()=>({assertJobLeaseAtWallTime:mocks.lease}));
vi.mock('@/lib/operations/dr/epoch',()=>({writerSiteActive:mocks.fence}));
vi.mock('@/lib/crawl/korean-discovery/repository',()=>({synchronizeKoreanQueries:mocks.sync}));
const {applyKoreanDiscovery}=await import('@/lib/crawl/korean-discovery/apply');
const ctx={cursor:null,save:async()=>{},hasBudget:()=>true,log:vi.fn(),lease:{name:'crawl-ko-apply',token:'token',requestedVersion:1}};
beforeEach(()=>{vi.resetAllMocks();mocks.settings.mockResolvedValue({enabled:true,discover:{maxNewPerHour:3000,maxReviewBacklog:1000000}});
  mocks.fence.mockResolvedValue(true);mocks.execute.mockResolvedValueOnce([{enabled:true}]).mockResolvedValueOnce([
    {repo:'a/yes',language:'yes',priority:60,signal:'first'},{repo:'b/yes',language:'yes',priority:55,signal:'second'},{repo:'c/no',language:'no',priority:50,signal:'third'}]);
  mocks.admit.mockResolvedValue({processed:1,added:1,remainingNew:0});mocks.txExecute.mockResolvedValue([]);});
it('applies one batch through shared admission and terminalizes only its admitted prefix while excluding confirmed non-Korean rows',async()=>{
  await applyKoreanDiscovery(ctx);expect(mocks.sync).toHaveBeenCalledWith(expect.anything(),ctx.lease);
  expect(mocks.admit).toHaveBeenCalledExactlyOnceWith([{repo:'a/yes',signal:'Oracle Korean',priority:60,builder:null},{repo:'b/yes',signal:'Oracle Korean',priority:55,builder:null}],
    {maxNewPerHour:3000,maxReviewBacklog:1000000},ctx.lease);
  const dialect=new PgDialect();const statements=mocks.txExecute.mock.calls.map(([query])=>dialect.sqlToQuery(query));
  expect(statements).toEqual(expect.arrayContaining([expect.objectContaining({params:['a/yes']}),expect.objectContaining({params:['c/no']})]));
  expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({counts:{discovered:1,existing:0}}));
});
it('preserves every Korean item when shared admission has no capacity',async()=>{
  mocks.admit.mockResolvedValue({processed:0,added:0,remainingNew:0});await applyKoreanDiscovery(ctx);
  expect(mocks.txExecute).toHaveBeenCalledTimes(1);const query=new PgDialect().sqlToQuery(mocks.txExecute.mock.calls[0][0]);expect(query.params).toEqual(['c/no']);
});

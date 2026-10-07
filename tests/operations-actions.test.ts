import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({admin:vi.fn(),agent:vi.fn(),audit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('@/lib/auth/admin',()=>({currentAdmin:mocks.admin}));
vi.mock('@/lib/operations/agent-client',()=>({agentRequest:mocks.agent}));
vi.mock('@/lib/db',()=>({db:{insert:()=>({values:mocks.audit})}}));
import { codexOperation } from '@/app/admin/status/actions';
beforeEach(()=>{vi.clearAllMocks();});

// 관리자 화면을 여는 사람이면 GitHub 로그인 없이도 다시 인증한다(운영은 로그인 없는 관리자 — ADMIN_LOCAL_LOGIN)
it('lets any admin who can open the admin screen reconnect Codex, without a GitHub session',async()=>{
 mocks.admin.mockResolvedValue({login:'local'});mocks.agent.mockResolvedValue({generation:2,configVersion:1});
 expect(await codexOperation('connect',{provider:'codex'})).toHaveProperty('status');
 expect(mocks.agent).toHaveBeenCalledWith('connect',{provider:'codex'});
 expect(mocks.audit).toHaveBeenCalledWith([expect.objectContaining({actor:'local',action:'ai-connect',detail:{generation:2,configVersion:1},ok:true})]);
});
it('refuses when there is no admin at all',async()=>{
 mocks.admin.mockResolvedValue(null);
 for(const action of ['connect','input','probe','status','test','apply','cancel'])expect(await codexOperation(action)).toHaveProperty('error');
 expect(mocks.agent).not.toHaveBeenCalled();
});
it('rejects arbitrary agent RPC actions',async()=>{
 mocks.admin.mockResolvedValue({login:'local'});
 expect(await codexOperation('classify')).toHaveProperty('error');
 expect(mocks.agent).not.toHaveBeenCalled();
});
it('forwards authorization input without putting it in the audit',async()=>{
 mocks.admin.mockResolvedValue({login:'local'});mocks.agent.mockResolvedValue({generation:2,configVersion:1});
 expect(await codexOperation('input',{id:'session',code:'private-oauth-code'})).toHaveProperty('status');
 expect(mocks.agent).toHaveBeenCalledWith('input',{id:'session',code:'private-oauth-code'});
 expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private-oauth-code');
});

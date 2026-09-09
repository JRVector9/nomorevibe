import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({session:vi.fn(),agent:vi.fn(),audit:vi.fn().mockResolvedValue(undefined)}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:'test-cookie'})})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('@/lib/auth/admin',()=>({currentAdmin:async()=>({login:'local'}),authSecret:()=> 'a'.repeat(32),adminLogins:()=>['allowed-admin']}));
vi.mock('@/lib/auth/session',()=>({SESSION_COOKIE:'test',verifySession:mocks.session}));
vi.mock('@/lib/operations/agent-client',()=>({agentRequest:mocks.agent}));
vi.mock('@/lib/db',()=>({db:{insert:()=>({values:mocks.audit})}}));
import { codexOperation } from '@/app/admin/status/actions';
beforeEach(()=>{vi.clearAllMocks();});
it('does not let local admin bypass manage credentials or model probes',async()=>{mocks.session.mockResolvedValue(null);for(const action of ['connect','input','probe','status','test','apply','cancel'])expect(await codexOperation(action)).toHaveProperty('error');expect(mocks.agent).not.toHaveBeenCalled();});
it('requires allowlisted real session and rejects arbitrary agent RPC actions',async()=>{mocks.session.mockResolvedValue({login:'outsider'});expect(await codexOperation('connect')).toHaveProperty('error');mocks.session.mockResolvedValue({login:'allowed-admin'});expect(await codexOperation('classify')).toHaveProperty('error');expect(mocks.agent).not.toHaveBeenCalled();});
it('authorizes explicit connect and audits metadata without credentials',async()=>{mocks.session.mockResolvedValue({login:'allowed-admin'});mocks.agent.mockResolvedValue({generation:2,configVersion:1});expect(await codexOperation('connect')).toHaveProperty('status');expect(mocks.agent).toHaveBeenCalledWith('connect',{});expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({actor:'allowed-admin',detail:{generation:2,configVersion:1}}));});

afterEach(()=>vi.unstubAllEnvs());
it('allows explicit loopback local mode without requiring GitHub OAuth',async()=>{
 vi.stubEnv('ADMIN_LOCAL_LOGIN','1');vi.stubEnv('ADMIN_LOCAL_CODEX','1');vi.stubEnv('NEXT_PUBLIC_SITE_URL','http://localhost:3200');
 mocks.session.mockResolvedValue(null);mocks.agent.mockResolvedValue({generation:0,configVersion:0});
 expect(await codexOperation('connect')).toHaveProperty('status');expect(mocks.agent).toHaveBeenCalledWith('connect',{});
});

it('forwards Claude authorization input without putting it in the audit',async()=>{
 mocks.session.mockResolvedValue({login:'allowed-admin'});mocks.agent.mockResolvedValue({generation:2,configVersion:1});
 expect(await codexOperation('input',{id:'session',code:'private-oauth-code'})).toHaveProperty('status');
 expect(mocks.agent).toHaveBeenCalledWith('input',{id:'session',code:'private-oauth-code'});
 expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private-oauth-code');
});

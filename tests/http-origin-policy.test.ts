import { afterEach, expect, it, vi } from 'vitest';
import { httpOriginPolicyHash, httpOriginPolicySchema, HttpOriginPermitError, sharedHttpEnabled } from '@/lib/net/http-origin-policy';
afterEach(()=>vi.unstubAllEnvs());
it('policy hash is independent of mapping order and accepts only fixed physical hosts',()=>{
  expect(httpOriginPolicyHash({version:1,instanceHosts:{b:'mini',a:'oracle-osaka-smoke'}})).toBe(httpOriginPolicyHash({version:1,instanceHosts:{a:'oracle-osaka-smoke',b:'mini'}}));
  expect(httpOriginPolicySchema.safeParse({version:1,instanceHosts:{a:'arbitrary-host'}}).success).toBe(false);
  expect(httpOriginPolicySchema.safeParse({version:1,instanceHosts:{a:'oracle-osaka-smoke'},oracleHosts:[]}).success).toBe(false);
  expect(httpOriginPolicySchema.safeParse({version:1,instanceHosts:{a:'oracle-osaka-smoke'},hostLimit:3}).success).toBe(false);
});
it('default disabled and explicit0 need no DB configuration; other flags fail closed',()=>{
  vi.stubEnv('HTTP_ORIGIN_PERMITS',undefined);expect(sharedHttpEnabled()).toBe(false);
  vi.stubEnv('HTTP_ORIGIN_PERMITS','0');expect(sharedHttpEnabled()).toBe(false);
  vi.stubEnv('HTTP_ORIGIN_PERMITS','true');expect(()=>sharedHttpEnabled()).toThrow(HttpOriginPermitError);
  vi.stubEnv('HTTP_ORIGIN_PERMITS','1');expect(sharedHttpEnabled()).toBe(true);
});
it('enabled injected request rejects before touching request, DNS, or a DB',async()=>{
  vi.stubEnv('HTTP_ORIGIN_PERMITS','1');
  const {fetchCapped}=await import('@/lib/net/fetch');const request=vi.fn();
  await expect(fetchCapped('https://injected.example',{maxBytes:1,request})).rejects.toMatchObject({code:'custom_transport'});
  expect(request).not.toHaveBeenCalled();
});

import { expect, it } from 'vitest';
import { localCodexEnabled } from '@/lib/auth/local-codex';
it('requires explicit local capability, local admin mode and loopback site URL',()=>{
 const env={ADMIN_LOCAL_LOGIN:'1',ADMIN_LOCAL_CODEX:'1',NEXT_PUBLIC_SITE_URL:'http://localhost:3200'};
 expect(localCodexEnabled(env)).toBe(true);
 for(const NEXT_PUBLIC_SITE_URL of ['https://example.com','http://localhost.evil.test','not a url',''])expect(localCodexEnabled({...env,NEXT_PUBLIC_SITE_URL})).toBe(false);
 expect(localCodexEnabled({...env,ADMIN_LOCAL_CODEX:'0'})).toBe(false);
 expect(localCodexEnabled({...env,ADMIN_LOCAL_LOGIN:'0'})).toBe(false);
});

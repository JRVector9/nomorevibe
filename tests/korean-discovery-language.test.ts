import { expect, it, vi } from 'vitest';
import { inspectKoreanProject, koreanProseEvidence, KOREAN_README_PATHS } from '@/lib/crawl/korean-discovery/language';
import type { KoreanDocumentRequest } from '@/lib/crawl/korean-discovery/language';
const prose = '이 프로젝트는 인공지능으로 제작한 일정 관리 서비스입니다. 사용자는 편리하게 새로운 일정을 등록하고 관리할 수 있습니다.';
const missing: KoreanDocumentRequest = async()=>({ok:false,reason:'http',status:404});
const document = (text:string) => ({ok:true as const,status:200,headers:new Headers(),finalUrl:'https://raw.githubusercontent.com/a/b/HEAD/README.md',body:Buffer.from(text)});
it('requires Korean explanatory prose instead of a link, filename, badge, code or isolated words',()=>{
  expect(koreanProseEvidence('[한국어](README.ko.md)\nHello world\n```\n'+prose+'\n```').yes).toBe(false);
  expect(koreanProseEvidence('<!-- '+prose+' -->\n한국어').yes).toBe(false);
  expect(koreanProseEvidence(prose).yes).toBe(true);
});
it('accepts a descriptive Korean introduction without fetching documents',async()=>{
  const request=vi.fn(missing);const result=await inspectKoreanProject('a/b',prose,{request});
  expect(result).toMatchObject({language:'yes',source:'description'});expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);expect(request).not.toHaveBeenCalled();
});
it('checks a localized document even when the default README is English',async()=>{
  const request=vi.fn<KoreanDocumentRequest>(async url=>url.endsWith('README.ko.md')?document(prose):document('An English app for scheduling.'));
  expect(await inspectKoreanProject('a/b',null,{request})).toMatchObject({language:'yes',source:'README.ko.md'});
  expect(request.mock.calls[0][0]).toBe('https://raw.githubusercontent.com/a/b/HEAD/README.md');
});
it('distinguishes all known absent documents from a transient fetch failure',async()=>{
  expect(await inspectKoreanProject('a/b',null,{request:missing})).toMatchObject({language:'no'});
  const request=vi.fn<KoreanDocumentRequest>(async url=>url.endsWith('README.md')?{ok:false,reason:'timeout'}:missing(url,{maxBytes:1,timeoutMs:1}));
  expect(await inspectKoreanProject('a/b',null,{request})).toMatchObject({language:'unknown',reason:'document_unavailable'});
  expect(request).toHaveBeenCalledTimes(KOREAN_README_PATHS.length);
});
it('treats truncation/size limits and an exhausted deadline as unknown and rejects unsafe repo identifiers',async()=>{
  expect(await inspectKoreanProject('a/b',null,{deadlineAt:Date.now()-1,request:missing})).toMatchObject({language:'unknown'});
  expect(await inspectKoreanProject('a/b',null,{request:async()=>({ok:false,reason:'too_large'})})).toMatchObject({language:'unknown'});
  await expect(inspectKoreanProject('../private',null,{request:missing})).rejects.toThrow('invalid_korean_repository');
});

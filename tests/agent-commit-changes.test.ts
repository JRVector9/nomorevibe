import { describe,expect,it } from 'vitest';
import { commitChangeObservations,isDevelopmentPath } from '@/lib/domain/evidence/agents/commit-changes';
const context={repositoryKey:'acme/app',commitSha:'a'.repeat(40),headSha:'b'.repeat(40),scope:''};
const base={message:'Fix\n\nCo-authored-by: Codex <noreply@example.com>',files:[{filename:'src/app.ts',changes:3}]};
describe('commit metadata as bounded contribution claims',()=>{
 it('retains source identity and changed paths without email or message',()=>{
  const [result]=commitChangeObservations(base,context);
  expect(result).toMatchObject({client:'codex',role:'coauthor',commitEvidence:{basis:'coauthor',changeKind:'development',changedPaths:['src/app.ts'],headSha:context.headSha}});
  expect(JSON.stringify(result)).not.toContain('@');
 });
 it.each(['README.md','docs/snippet.ts','templates/app.ts','tests/app.ts','src/app.test.ts','src/types.d.ts','vendor/lib.c'])('keeps %s outside development claims',filename=>{
  expect(isDevelopmentPath(filename)).toBe(false);
  expect(commitChangeObservations({...base,files:[{filename,changes:1}]},context)[0].commitEvidence?.changeKind).toBe('other');
 });
 it('requires a real changed file in the requested product scope',()=>{
  expect(commitChangeObservations({...base,files:[]},context)).toEqual([]);
  expect(commitChangeObservations({...base,files:[{filename:'src/app.ts',changes:0}]},context)).toEqual([]);
  expect(commitChangeObservations(base,{...context,scope:'apps/web'})).toEqual([]);
  expect(commitChangeObservations({...base,files:[{filename:'../app.ts',changes:1}]},context)).toEqual([]);
 });
 it('separates Aider authorship from committing existing work',()=>{
  expect(commitChangeObservations({...base,message:'Fix',authorName:'Dev (aider)',committerName:'Dev (aider)'},context)[0].role).toBe('author');
  expect(commitChangeObservations({...base,message:'Fix',authorName:'Dev',committerName:'Dev (aider)'},context)[0].role).toBe('committer');
  expect(commitChangeObservations({...base,message:'Fix',authorName:'aider fan'},context)).toEqual([]);
 });
 it('bounds path evidence and keeps a source path beyond many docs',()=>{
  const files=[...Array.from({length:40},(_,i)=>({filename:`docs/${i}.md`,changes:1})),...base.files];
  const [result]=commitChangeObservations({...base,files},context);
  expect(result.commitEvidence?.changedPaths).toHaveLength(20);
  expect(result.commitEvidence?.changedPaths[0]).toBe('src/app.ts');
 });
});

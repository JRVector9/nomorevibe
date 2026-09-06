import { describe, expect, it } from 'vitest';
import { parseCommitAttributions } from '@/lib/domain/evidence/agents/commit-attribution';
describe('commit attribution trailers', () => {
  it('does not mistake a codex body mention for the Qwen coauthor', () => {
    expect(parseCommitAttributions('fix codex: permissions\n\nCo-authored-by: Qwen-Coder <qwen@example.com>')).toEqual([{client:'qwen-code',label:'Qwen-Coder'}]);
  });
  it('preserves multiple known clients and drops emails', () => {
    expect(parseCommitAttributions('fix\n\nCo-authored-by: Claude <a@example.com>\nCo-authored-by: OpenAI Codex <b@example.com>\nSigned-off-by: Human <human@example.com>')).toEqual([{client:'claude-code',label:'Claude'},{client:'codex',label:'OpenAI Codex'}]);
  });
  it.each(['fix\n\nCo-authored-by: Claude <a@example.com>\n\nThis is body text.', 'fix\n\n```\nCo-authored-by: Claude <a@example.com>\n```','fix\n\n> Co-authored-by: Claude <a@example.com>','fix Co-authored-by: Claude <a@example.com>'])('ignores non-trailer text', message => {
    expect(parseCommitAttributions(message)).toEqual([]);
  });
  it('keeps unknown names unassigned and never infers a client from the email', () => {
    expect(parseCommitAttributions('fix\n\nCo-authored-by: Some Person <claude@example.com>')).toEqual([{client:null,label:'Some Person'}]);
  });
  it('recognizes versioned Claude trailer names without matching arbitrary Claude prose', () => {
    expect(parseCommitAttributions('fix\n\nCo-authored-by: Claude Opus 4.6 <a@example.com>')).toEqual([{client:'claude-code',label:'Claude Opus 4.6'}]);
    expect(parseCommitAttributions('fix\n\nCo-authored-by: Claude My Coworker <a@example.com>')[0].client).toBeNull();
  });
});

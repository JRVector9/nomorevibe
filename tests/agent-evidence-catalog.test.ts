import { describe, expect, it } from 'vitest';
import { ARTIFACT_RULES, matchAgentArtifact } from '@/lib/domain/evidence/agents/catalog';

describe('versioned public agent artifact catalog', () => {
  it.each([
    ['AGENTS.md','100644','shared_instruction'], ['AGENTS.override.md','100644','shared_instruction'],
    ['.claude/settings.json','100644','client_config'], ['.codex','100644','unsupported'],
    ['.codex/config.toml','100644','client_config'], ['.grok/config.toml','100644','client_config'],
    ['.kimi-code/agents/reviewer.md','100644','agent_definition'], ['.agents/agents/reviewer.md','100644','shared_instruction'],
    ['fixtures/CLAUDE.md','100644','example_only'], ['CLAUDE.md','120000','symlink'], ['.claude','160000','submodule'],
    ['.cursor/rules/style.mdc','100644','instruction_file'], ['.clinerules','100644','instruction_file'],
    ['.roo/rules-review/style.md','100644','instruction_file'], ['opencode.jsonc','100644','client_config'],
    ['.aider.conf.yml','100644','client_config'], ['.continue/rules/style.md','100644','instruction_file'],
    ['GEMINI.md','100644','shared_instruction'], ['QWEN.md','100644','instruction_file'],
    ['.github/instructions/ui/react.instructions.md','100644','instruction_file'],
    ['.windsurf/rules/style.md','100644','instruction_file'], ['.devin/rules/style.md','100644','instruction_file'],
    ['.goosehints','100644','instruction_file'], ['.factory/droids/review.md','100644','agent_definition'],
    ['.kiro/steering/project.md','100644','instruction_file'], ['.agents/skills/foo/SKILL.md','100644','shared_instruction'],
    ['.env','100644','unsupported'], ['.claude/settings.local.json','100644','unsupported'],
    ['claude.md','100644','unsupported'], ['../CLAUDE.md','100644','unsupported'],
  ])('%s (%s) => %s', (path, mode, classification) => {
    expect(matchAgentArtifact(path, mode).classification).toBe(classification);
  });
  it('preserves subproject scope without assigning it to the repository root', () => {
    expect(matchAgentArtifact('apps/web/CLAUDE.md')).toMatchObject({scope:'apps/web'});
    expect(matchAgentArtifact('apps/web/.claude/settings.json')).toMatchObject({scope:'apps/web'});
  });
  it('never promotes example copies for any supported format', () => {
    for (const path of ['.claude/settings.json','.codex/config.toml','opencode.json','.aider.conf.yml','QWEN.md','.factory/droids/foo.md']) {
      expect(matchAgentArtifact(`examples/demo/${path}`).classification).toBe('example_only');
    }
  });
  it('records version and official source for every rule', () => {
    expect(new Set(ARTIFACT_RULES.map(rule => rule.id)).size).toBe(ARTIFACT_RULES.length);
    for (const rule of ARTIFACT_RULES) expect(rule).toMatchObject({version:1, checkedOn:'2026-09-06', docsUrl:expect.stringMatching(/^https:\/\//)});
  });
});

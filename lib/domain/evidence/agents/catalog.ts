export type ArtifactRule = {
  id: string; version: number; docsUrl: string; checkedOn: '2026-09-06';
  pathPattern: string; compatibleClients: string[];
  format: 'markdown' | 'json' | 'jsonc' | 'toml' | 'yaml';
  scope: 'project' | 'shared' | 'explicit_reference';
  classification: 'shared_instruction' | 'client_config' | 'agent_definition' | 'instruction_file';
  client: string | null;
};
export const AGENT_DIRECTORY_PREFIXES = [
  '.claude','.codex','.grok','.kimi','.kimi-code','.agents','.cursor','.clinerules',
  '.roo','.opencode','.continue','.gemini','.qwen','.github/instructions','.github/agents',
  '.windsurf','.devin','.factory','.kiro',
] as const;
type Classification = ArtifactRule['classification'] | 'example_only' | 'unsupported' | 'symlink' | 'submodule';
const rules: ArtifactRule[] = [];
function add(id: string, pathPattern: string, client: string | null, format: ArtifactRule['format'], docsUrl: string, classification: ArtifactRule['classification'] = 'instruction_file', compatibleClients = client ? [client] : ['codex','kimi','grok-build','opencode','github-copilot','cursor','kiro']) {
  rules.push({id:`${id}.v1`, version:1, checkedOn:'2026-09-06', pathPattern, client, compatibleClients, format, docsUrl, classification, scope:client === null ? 'shared' : 'project'});
}
add('shared.agents','AGENTS(?:\\.override)?\\.md',null,'markdown','https://developers.openai.com/codex/guides/agents-md','shared_instruction');
add('shared.claude','(?:\\.claude/)?CLAUDE\\.md',null,'markdown','https://code.claude.com/docs/en/memory','shared_instruction',['claude-code','cursor','opencode','kimi','grok-build']);
add('claude.settings','\\.claude/settings\\.json','claude-code','json','https://code.claude.com/docs/en/settings','client_config');
add('claude.rules','\\.claude/rules/.+\\.md','claude-code','markdown','https://code.claude.com/docs/en/memory');
add('claude.agents','\\.claude/agents/.+\\.md','claude-code','markdown','https://code.claude.com/docs/en/sub-agents','agent_definition');
add('codex.config','\\.codex/config\\.toml','codex','toml','https://developers.openai.com/codex/config-basic','client_config');
add('grok.config','\\.grok/config\\.toml','grok-build','toml','https://docs.x.ai/build/settings','client_config');
add('kimi.instructions','\\.kimi/AGENTS\\.md',null,'markdown','https://moonshotai.github.io/kimi-cli/en/customization/agents.html','shared_instruction',['kimi']);
add('kimi.agents','\\.kimi-code/agents/.+\\.md','kimi','markdown','https://moonshotai.github.io/kimi-code/en/customization/agents','agent_definition');
add('shared.agents-directory','\\.agents/agents/.+\\.md',null,'markdown','https://moonshotai.github.io/kimi-code/en/customization/agents','shared_instruction');
add('shared.skills','(?:\\.agents|\\.claude|\\.codex|\\.kimi|\\.grok)/skills/.+/SKILL\\.md',null,'markdown','https://moonshotai.github.io/kimi-cli/en/customization/skills.html','shared_instruction');
add('cursor.rules','(?:\\.cursor/rules/.+\\.mdc|\\.cursorrules)','cursor','markdown','https://docs.cursor.com/context/rules-for-ai');
add('cline.rules','\\.clinerules(?:/.+\\.md)?','cline','markdown','https://docs.cline.bot/customization/cline-rules');
add('roo.rules','(?:\\.roo/rules(?:-[^/]+)?/.+\\.md|\\.roorules(?:-[^/]+)?)','roo-code','markdown','https://docs.roocode.com/features/custom-instructions');
add('opencode.config','opencode\\.jsonc?','opencode','jsonc','https://opencode.ai/docs/config/','client_config');
add('opencode.agents','\\.opencode/agents/.+\\.md','opencode','markdown','https://opencode.ai/docs/agents','agent_definition');
add('aider.config','\\.aider\\.conf\\.yml','aider','yaml','https://aider.chat/docs/config/aider_conf.html','client_config');
add('aider.model-definitions','\\.aider\\.model\\.settings\\.yml','aider','yaml','https://aider.chat/docs/config/adv-model-settings.html','client_config');
add('continue.rules','\\.continue/rules/.+\\.md','continue','markdown','https://docs.continue.dev/customize/rules');
add('gemini.instructions','GEMINI\\.md',null,'markdown','https://geminicli.com/docs/cli/gemini-md/','shared_instruction',['gemini-cli','github-copilot']);
add('gemini.config','\\.gemini/settings\\.json','gemini-cli','json','https://geminicli.com/docs/reference/configuration/','client_config');
add('qwen.instructions','QWEN\\.md','qwen-code','markdown','https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/');
add('qwen.config','\\.qwen/settings\\.json','qwen-code','json','https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/','client_config');
add('copilot.instructions','\\.github/(?:copilot-instructions\\.md|instructions/.+\\.instructions\\.md)','github-copilot','markdown','https://docs.github.com/en/copilot/reference/custom-instructions-support');
add('copilot.agents','\\.github/agents/.+\\.agent\\.md','github-copilot','markdown','https://docs.github.com/en/copilot/reference/custom-agents-configuration','agent_definition');
add('windsurf.rules','(?:\\.windsurf/rules/.+\\.md|\\.windsurfrules)','windsurf','markdown','https://docs.devin.ai/desktop/cascade/memories');
add('devin.rules','\\.devin/rules/.+\\.md','devin-desktop','markdown','https://docs.devin.ai/desktop/cascade/memories');
add('goose.instructions','\\.goosehints','goose','markdown','https://github.com/aaif-goose/goose/blob/main/ui/desktop/.goosehints');
add('factory.droids','\\.factory/droids/.+\\.md','factory-droid','markdown','https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control','agent_definition');
add('factory.settings','\\.factory/settings\\.json','factory-droid','json','https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control','client_config');
add('kiro.steering','\\.kiro/steering/.+\\.md','kiro','markdown','https://kiro.dev/docs/steering/');
export const ARTIFACT_RULES: readonly ArtifactRule[] = rules;

export function matchAgentArtifact(path: string, mode = '100644', type = 'blob'): {classification: Classification; rule: ArtifactRule | null; scope: string} {
  const unsupported = {classification:'unsupported' as const,rule:null,scope:''};
  if (!path || path.length > 1000 || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || !p)) return unsupported;
  if (mode === '160000' || type === 'commit') return {...unsupported,classification:'submodule'};
  if (mode === '120000') return {...unsupported,classification:'symlink'};
  if (type !== 'blob' || !['100644','100755'].includes(mode)) return unsupported;
  const segments = path.split('/');
  // Try the most specific complete suffix first; nested instructions retain their parent scope.
  for (let i = 0; i < segments.length; i++) {
    const relative = segments.slice(i).join('/');
    const rule = ARTIFACT_RULES.find(candidate => new RegExp(`^(?:${candidate.pathPattern})$`).test(relative));
    if (rule) {
      const example = segments.some(part => /^(?:examples?|fixtures?|__fixtures__|vendor|templates?|node_modules|testdata)$/i.test(part));
      return {classification:example ? 'example_only' : rule.classification,rule,scope:segments.slice(0,i).join('/')};
    }
  }
  return unsupported;
}

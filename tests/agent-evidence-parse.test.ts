import { describe, expect, it } from 'vitest';
import { matchAgentArtifact } from '@/lib/domain/evidence/agents/catalog';
import { parseAgentArtifact } from '@/lib/domain/evidence/agents/parse';

const parse = (path: string, content: string) => {
  const rule = matchAgentArtifact(path).rule;
  if (!rule) throw new Error('test requires a registered rule');
  return parseAgentArtifact({rule,path,content,repository:{owner:'acme',name:'app'},commitSha:'a'.repeat(40),blobSha:'b'.repeat(40)});
};
const models = (path:string, content:string) => parse(path,content).observations.filter(o => o.kind === 'model_config');
describe('agent configuration facts', () => {
  it('separates Claude client, GLM model and Z.AI gateway and drops credentials', () => {
    const result = parse('.claude/settings.json', JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://api.z.ai/api/anthropic',ANTHROPIC_DEFAULT_SONNET_MODEL:'glm-4.7',ANTHROPIC_AUTH_TOKEN:'DO_NOT_PERSIST_SECRET'}}));
    expect(result.observations).toContainEqual(expect.objectContaining({kind:'model_config',client:'claude-code',gateway:'z-ai',declaredModelId:'glm-4.7',modelDeveloper:'z-ai',role:'sonnet'}));
    expect(JSON.stringify(result)).not.toContain('DO_NOT_PERSIST_SECRET');
  });
  it('does not resolve DeepSeek compatible aliases into actual Claude execution', () => {
    expect(models('.claude/settings.json', JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_MODEL:'claude-sonnet-4'}}))).toEqual([expect.objectContaining({gateway:'deepseek-direct',declaredModelId:'claude-sonnet-4',modelDeveloper:null,routing:'unknown'})]);
  });
  it('parses OpenCode selected roles, ignores available models and preserves auto', () => {
    expect(models('opencode.jsonc', '{// comment\n"model":"openrouter/x-ai/grok-code-fast-1", "small_model":"openrouter/openrouter/auto", "provider":{"openrouter":{"models":{"fake-selected":{}}}},}'))
      .toEqual([expect.objectContaining({client:'opencode',gateway:'openrouter',declaredModelId:'x-ai/grok-code-fast-1',modelDeveloper:'x-ai',role:'main'}),expect.objectContaining({routing:'auto',modelDeveloper:null,role:'small'})]);
    expect(models('opencode.json','{"provider":{"openrouter":{"models":{"glm-4.7":{}}}}}')).toEqual([]);
  });
  it('does not call an overridden OpenRouter provider a confirmed OpenRouter connection', () => {
    expect(models('opencode.json',JSON.stringify({model:'openrouter/x-ai/grok-code-fast-1',provider:{openrouter:{options:{baseURL:'https://proxy.example/v1'}}}}))[0]).toMatchObject({gateway:null,declaredModelId:'x-ai/grok-code-fast-1'});
  });
  it('does not emit models for disabled OpenCode agents', () => {
    expect(models('opencode.json','{"agent":{"review":{"disable":true,"model":"openrouter/deepseek/deepseek-chat"}}}')).toEqual([]);
  });
  it.each([
    ['.gemini/settings.json','{"model":{"name":"gemini-2.5-pro"}}','gemini-cli','google'],
    ['.qwen/settings.json','{"model":{"name":"qwen3-coder"}}','qwen-code','alibaba'],
    ['.factory/settings.json','{"sessionDefaultSettings":{"model":"gpt-5"}}','factory-droid','openai'],
    ['.opencode/agents/review.md','---\nmodel: openrouter/moonshotai/kimi-k2.5\n---\nReview','opencode','moonshot'],
  ])('parses supported model selection in %s', (path, content, client, modelDeveloper) => {
    expect(models(path,content)).toEqual([expect.objectContaining({client,modelDeveloper})]);
  });
  it('does not select Aider model definitions or inactive Codex profiles', () => {
    expect(models('.aider.model.settings.yml','- name: glm-4.7\n  extra_params:\n    api_key: DO_NOT_PERSIST_SECRET')).toEqual([]);
    expect(models('.codex/config.toml','[profiles.review]\nmodel="gpt-5"')).toEqual([]);
  });
  it('maps explicitly selected Aider aliases and model roles', () => {
    expect(models('.aider.conf.yml','alias:\n  - quick:openrouter/deepseek/deepseek-chat\nmodel: quick')[0]).toMatchObject({declaredModelId:'deepseek/deepseek-chat',gateway:'openrouter',role:'main'});
  });
  it('shared AGENTS and CLAUDE never imply an underlying model or a unique client', () => {
    expect(parse('AGENTS.md','# Codex and Kimi instructions').observations[0]).toMatchObject({client:null,declaredModelId:null});
    expect(parse('CLAUDE.md','# use Claude').observations[0]).toMatchObject({client:null,declaredModelId:null,compatibleClients:expect.arrayContaining(['claude-code'])});
  });
  it('does not accept user-scope model keys in Grok project config', () => {
    expect(models('.grok/config.toml','model = "grok-4"')).toEqual([]);
  });
  it('parses new Kimi agent frontmatter without persisting the prompt', () => {
    expect(models('.kimi-code/agents/review.md','---\nname: review\nmodel: kimi-k2.5\n---\nDO_NOT_PERSIST_SECRET')).toEqual([expect.objectContaining({client:'kimi',modelDeveloper:'moonshot',declaredModelId:'kimi-k2.5'})]);
    expect(JSON.stringify(parse('.kimi-code/agents/review.md','---\nmodel: kimi-k2.5\n---\nDO_NOT_PERSIST_SECRET'))).not.toContain('DO_NOT_PERSIST_SECRET');
  });
  it('parses Codex TOML custom provider but leaves environment model references unresolved', () => {
    const result = models('.codex/config.toml','model = "${MODEL}"\nmodel_provider = "openrouter"\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "SECRET_KEY"');
    expect(result).toEqual([expect.objectContaining({declaredModelId:null,gateway:'openrouter',routing:'unknown'})]);
  });
  it('keeps Aider roles and Factory inheritance unresolved', () => {
    expect(models('.aider.conf.yml','model: openrouter/deepseek/deepseek-chat\nweak-model: glm-4.7\neditor-model: inherit')).toEqual([
      expect.objectContaining({role:'main',gateway:'openrouter',modelDeveloper:'deepseek'}),expect.objectContaining({role:'weak',modelDeveloper:'z-ai'}),expect.objectContaining({role:'editor',declaredModelId:null,routing:'unknown'}),
    ]);
    expect(models('.factory/droids/reviewer.md','---\nmodel: inherit\n---\nReview code.')).toEqual([expect.objectContaining({client:'factory-droid',declaredModelId:null})]);
  });
  it.each(['https://api.z.ai.attacker.example/api/anthropic','https://user:pass@api.z.ai/api/anthropic','http://api.z.ai/api/anthropic','https://api.z.ai:444/api/anthropic','http://localhost:1234'])('does not trust endpoint %s', endpoint => {
    expect(models('.claude/settings.json',JSON.stringify({env:{ANTHROPIC_BASE_URL:endpoint,ANTHROPIC_MODEL:'glm-4.7'}}))[0].gateway).toBeNull();
  });
  it.each(['model: &alias glm-4.7\nweak-model: *alias','model: !custom glm-4.7','model: ['])('rejects unsafe/invalid YAML without echoing content', content => {
    const result = parse('.aider.conf.yml', content);
    expect(['invalid','unsupported']).toContain(result.status);
    expect(result.observations).toEqual([]);
  });
  it('rejects broken JSON, oversize data, and credential-shaped model values', () => {
    expect(parse('.claude/settings.json','{"SECRET":"DO_NOT_PERSIST_SECRET"').status).toBe('invalid');
    expect(parse('AGENTS.md','x'.repeat(65537)).status).toBe('unsupported');
    expect(models('.claude/settings.json','{"model":"sk-secretcredential123"}')[0]?.declaredModelId ?? null).toBeNull();
  });
  it('constructs immutable evidence URLs, never uses content URLs', () => {
    expect(parse('CLAUDE.md','[source](https://evil.example/secret)').observations[0].sourceUrl).toBe(`https://github.com/acme/app/blob/${'a'.repeat(40)}/CLAUDE.md`);
  });
});

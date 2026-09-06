import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { isAlias, parseDocument, visit } from 'yaml';
import { matchAgentArtifact, type ArtifactRule } from './catalog';
import { agentObservationSchema, type AgentObservation } from './types';
import { gatewayFromEndpoint, resolveModelRouting, safeModelId } from './model-routing';

export type ParseArtifactInput = {
  rule: ArtifactRule; path: string; content: string; repository: {owner:string;name:string};
  commitSha: string; blobSha: string;
};
export type ParseArtifactResult = {observations: AgentObservation[]; status:'ok'|'unsupported'|'invalid'};
const MAX_BYTES = 64 * 1024;
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
class UnsupportedFormat extends Error {}
function yamlData(content: string): unknown {
  const doc = parseDocument(content, {customTags:[],uniqueKeys:true,strict:true});
  if (doc.errors.length) throw new Error('invalid');
  if (doc.warnings.length) throw new UnsupportedFormat();
  visit(doc, (_, node) => {
    if (isAlias(node) || (node && typeof node === 'object' && 'tag' in node && node.tag)) throw new UnsupportedFormat();
  });
  return doc.toJS({maxAliasCount:0});
}
function readData(input: ParseArtifactInput): unknown {
  if (input.rule.format === 'json') return JSON.parse(input.content);
  if (input.rule.format === 'jsonc') {
    const errors: ParseError[] = [];
    const data = parseJsonc(input.content, errors, {allowTrailingComma:true,disallowComments:false});
    if (errors.length) throw new Error('invalid');
    return data;
  }
  if (input.rule.format === 'toml') return parseToml(input.content);
  if (input.rule.format === 'yaml') return yamlData(input.content);
  const frontmatter = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return frontmatter ? yamlData(frontmatter[1]) : {};
}

export function parseAgentArtifact(input: ParseArtifactInput): ParseArtifactResult {
  const empty = (status:ParseArtifactResult['status']): ParseArtifactResult => ({status,observations:[]});
  if (Buffer.byteLength(input.content,'utf8') > MAX_BYTES) return empty('unsupported');
  const match = matchAgentArtifact(input.path);
  if (!match.rule || match.rule.id !== input.rule.id || match.classification === 'example_only') return empty('unsupported');
  if (!/^[a-zA-Z0-9_.-]+$/.test(input.repository.owner) || !/^[a-zA-Z0-9_.-]+$/.test(input.repository.name)) return empty('invalid');
  const rule = match.rule;
  const sourceUrl = `https://github.com/${input.repository.owner}/${input.repository.name}/blob/${input.commitSha}/${input.path.split('/').map(encodeURIComponent).join('/')}`;
  const base: AgentObservation = {
    kind:rule.classification === 'client_config' ? 'client_config' : 'instruction_file',
    client:rule.client,compatibleClients:rule.compatibleClients,modelDeveloper:null,declaredModelId:null,
    gateway:null,routing:'unknown',role:null,scope:match.scope,keyPath:null,ruleId:rule.id,
    sourcePath:input.path,commitSha:input.commitSha,blobSha:input.blobSha,sourceUrl,
  };
  if (!agentObservationSchema.safeParse(base).success) return empty('invalid');
  // Instruction prose is not model configuration and is never retained or interpreted.
  if (rule.classification === 'shared_instruction' || rule.classification === 'instruction_file') return {status:'ok',observations:[base]};
  let raw: unknown;
  try { raw = readData(input); } catch (error) { return empty(error instanceof UnsupportedFormat ? 'unsupported' : 'invalid'); }
  if (raw === null || typeof raw !== 'object') return empty('invalid');
  const data = object(raw);
  const observations: AgentObservation[] = [base];
  const add = (value: unknown, keyPath: string, role: string, gateway: string|null = null, options: {stripProvider?:boolean; fallback?:boolean; endpointConfigured?:boolean} = {}) => {
    if (typeof value !== 'string' || value.length > 160) return;
    const safeRole = safeModelId(role);
    // Unknown dynamically named keys cannot inject source content into stored paths/roles.
    if (!safeRole || keyPath.length > 300 || !/^[a-zA-Z0-9_.[\]-]+$/.test(keyPath)) return;
    observations.push({...base,kind:'model_config',keyPath,role:safeRole,...resolveModelRouting(value,{gateway,...options})});
  };
  if (rule.id === 'claude.settings.v1') {
    const env = object(data.env);
    const gateway = gatewayFromEndpoint(env.ANTHROPIC_BASE_URL);
    observations[0] = {...base,gateway};
    add(data.model,'model','main',gateway);
    add(env.ANTHROPIC_MODEL,'env.ANTHROPIC_MODEL','main',gateway);
    for (const role of ['HAIKU','SONNET','OPUS']) add(env[`ANTHROPIC_DEFAULT_${role}_MODEL`],`env.ANTHROPIC_DEFAULT_${role}_MODEL`,role.toLowerCase(),gateway);
  } else if (rule.id === 'codex.config.v1') {
    const providerId = safeModelId(data.model_provider);
    const provider = providerId ? object(object(data.model_providers)[providerId]) : {};
    const gateway = gatewayFromEndpoint(provider.base_url);
    observations[0] = {...base,gateway};
    add(data.model,'model','main',gateway);
    add(data.review_model,'review_model','review',gateway);
    // Profiles are options, not necessarily selected. Only an explicitly selected profile is read.
    const profileId = safeModelId(data.profile);
    if (profileId) {
      const profile = object(object(data.profiles)[profileId]);
      const profileProviderId = safeModelId(profile.model_provider) ?? providerId;
      const profileProvider = profileProviderId ? object(object(data.model_providers)[profileProviderId]) : {};
      add(profile.model,`profiles.${profileId}.model`,'profile',gatewayFromEndpoint(profileProvider.base_url));
    }
  } else if (rule.id === 'opencode.config.v1') {
    const selected = (value: unknown,keyPath: string,role: string) => {
      const providerId = typeof value === 'string' ? value.split('/')[0] : '';
      const providerOptions = object(object(object(data.provider)[providerId]).options);
      const endpointConfigured = typeof providerOptions.baseURL === 'string';
      add(value,keyPath,role,gatewayFromEndpoint(providerOptions.baseURL),{stripProvider:true,endpointConfigured});
    };
    selected(data.model,'model','main');
    selected(data.small_model,'small_model','small');
    for (const [name, config] of Object.entries(object(data.agent)).slice(0,32)) {
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && object(config).disable !== true) selected(object(config).model,`agent.${name}.model`,name);
    }
  } else if (rule.id === 'aider.config.v1') {
    const aliases = new Map<string,string>();
    if (Array.isArray(data.alias)) for (const item of data.alias.slice(0,32)) {
      if (typeof item !== 'string') continue;
      const colon = item.indexOf(':');
      const name = safeModelId(item.slice(0,colon)); const model = safeModelId(item.slice(colon + 1));
      if (colon > 0 && name && model) aliases.set(name,model);
    }
    for (const [key,role] of [['model','main'],['weak-model','weak'],['editor-model','editor']]) {
      const value = data[key]; add(typeof value === 'string' ? aliases.get(value) ?? value : value,key,role,null,{stripProvider:true});
    }
  } else if (rule.id === 'gemini.config.v1' || rule.id === 'qwen.config.v1') {
    const model = object(data.model);
    add(typeof data.model === 'string' ? data.model : model.name, typeof data.model === 'string' ? 'model' : 'model.name','main');
  } else if (rule.id === 'factory.settings.v1') {
    add(data.model,'model','main');
    add(object(data.sessionDefaultSettings).model,'sessionDefaultSettings.model','main');
  } else if (rule.classification === 'agent_definition') {
    add(data.model,'model','agent',null,{stripProvider:rule.client === 'opencode'});
  }
  // Grok project settings and Aider model definitions do not select an active model.
  return {status:'ok',observations};
}

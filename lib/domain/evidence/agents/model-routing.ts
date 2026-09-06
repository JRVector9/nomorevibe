import type { AgentObservation } from './types';

/** Only public identifiers are retained. Endpoint strings, auth, and raw config are never returned. */
export function safeModelId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:~+\[\]-]*$/.test(value)) return null;
  if (/^(?:inherit|default|auto|latest|none|null)$/i.test(value) || /^(?:sk[-_]|gh[pousr]_|github_pat_|Bearer|DO_NOT_PERSIST)/i.test(value)) return null;
  return value;
}

export function gatewayFromEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/$/,'');
    const known: Record<string, {gateway:string; paths:string[]}> = {
      'api.z.ai': {gateway:'z-ai',paths:['/api/anthropic','/api/coding/paas/v4','/api/paas/v4']},
      'api.deepseek.com': {gateway:'deepseek-direct',paths:['','/v1','/anthropic']},
      'openrouter.ai': {gateway:'openrouter',paths:['/api','/api/v1']},
      'api.x.ai': {gateway:'x-ai-direct',paths:['/v1']},
      'api.moonshot.ai': {gateway:'moonshot-direct',paths:['/v1']},
      'api.moonshot.cn': {gateway:'moonshot-direct',paths:['/v1']},
      'api.kimi.com': {gateway:'kimi-direct',paths:['/coding','/coding/v1']},
      'api.anthropic.com': {gateway:'anthropic-direct',paths:['','/v1']},
      'api.openai.com': {gateway:'openai-direct',paths:['/v1']},
    };
    const entry = known[url.hostname];
    return entry?.paths.includes(path) ? entry.gateway : null;
  } catch { return null; }
}

export function modelDeveloperFromId(id: string | null): string | null {
  if (!id) return null;
  const model = id.toLowerCase().replace(/^~/,'');
  if (/(?:^|\/)(?:grok[-.]|x-ai\/)/.test(model)) return 'x-ai';
  if (/(?:^|\/)(?:kimi[-.]|moonshot[-.]|moonshotai\/)/.test(model)) return 'moonshot';
  if (/(?:^|\/)(?:glm[-.]|z-ai\/|zhipuai\/)/.test(model)) return 'z-ai';
  if (/(?:^|\/)deepseek(?:[-/]|$)/.test(model)) return 'deepseek';
  if (/(?:^|\/)(?:claude[-.]|anthropic\/)/.test(model)) return 'anthropic';
  if (/(?:^|\/)(?:gpt[-.]|o[134](?:[-/]|$)|openai\/)/.test(model)) return 'openai';
  if (/(?:^|\/)(?:gemini[-.]|google\/)/.test(model)) return 'google';
  if (/(?:^|\/)(?:qwen[-.0-9/]|qwen3)/.test(model)) return 'alibaba';
  return null;
}

export function resolveModelRouting(value: unknown, options: {gateway?: string|null; stripProvider?: boolean; fallback?: boolean; endpointConfigured?: boolean} = {}): Pick<AgentObservation,'declaredModelId'|'modelDeveloper'|'gateway'|'routing'> {
  let declaredModelId = safeModelId(value);
  let gateway = options.gateway ?? null;
  if (declaredModelId && options.stripProvider) {
    // The first namespace identifies the configured connection, not the model developer.
    const prefix = declaredModelId.split('/')[0];
    if (prefix === 'openrouter') {
      if (!options.endpointConfigured) gateway ??= 'openrouter';
      declaredModelId = declaredModelId.slice(prefix.length + 1) || null;
    }
    else if (['anthropic','openai','deepseek','xai','moonshot','zai'].includes(prefix) && declaredModelId.includes('/')) {
      const direct: Record<string,string> = {anthropic:'anthropic-direct',openai:'openai-direct',deepseek:'deepseek-direct',xai:'x-ai-direct',moonshot:'moonshot-direct',zai:'z-ai'};
      if (!options.endpointConfigured) gateway ??= direct[prefix];
      declaredModelId = declaredModelId.slice(prefix.length + 1);
    }
  }
  const auto = declaredModelId === 'openrouter/auto' || (gateway === 'openrouter' && declaredModelId === 'auto');
  let modelDeveloper = auto ? null : modelDeveloperFromId(declaredModelId);
  let routing: AgentObservation['routing'] = !declaredModelId ? 'unknown' : auto ? 'auto' : options.fallback ? 'fallback' : 'fixed';
  // Compatible endpoints may remap a Claude alias to a non-Anthropic model. Do not guess its target.
  if (modelDeveloper === 'anthropic' && gateway && !['anthropic-direct','openrouter'].includes(gateway)) { modelDeveloper = null; routing = 'unknown'; }
  return {declaredModelId,modelDeveloper,gateway,routing};
}

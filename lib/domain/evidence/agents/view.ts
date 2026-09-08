import type { AgentObservation, AgentScanState } from "./types";
const CLIENTS: Record<string, string> = { "claude-code":"Claude Code",codex:"Codex",cursor:"Cursor",cline:"Cline",roo:"Roo Code",opencode:"OpenCode",aider:"Aider",continue:"Continue","gemini-cli":"Gemini CLI","qwen-code":"Qwen Code","grok-build":"Grok Build","kimi-cli":"Kimi CLI","kimi-code":"Kimi Code",copilot:"GitHub Copilot",windsurf:"Windsurf",goose:"Goose",factory:"Factory Droid",kiro:"Kiro",kimi:"Kimi Code","roo-code":"Roo Code","factory-droid":"Factory Droid","github-copilot":"GitHub Copilot","devin-desktop":"Devin Desktop" };
const GATEWAYS: Record<string, string> = { "z-ai":"Z.AI",openrouter:"OpenRouter","deepseek-direct":"DeepSeek",deepseek:"DeepSeek",xai:"xAI",moonshot:"Moonshot",anthropic:"Anthropic",openai:"OpenAI","x-ai-direct":"xAI","moonshot-direct":"Moonshot","kimi-direct":"Kimi","openai-direct":"OpenAI","anthropic-direct":"Anthropic" };
export type ObservedAgentFactView = {
  label:string; clientLabel:string; modelLabel:string; gatewayLabel:string; role:string|null; scope:string;
  sourceUrl:string; sourcePath:string|null; commitSha:string; observedAt:Date;
  coverageLabel:string|null; relationshipLabel:string|null; executionVerified:false;
};
export function presentObservedAgentFacts(input: { observations:AgentObservation[]; scanState:AgentScanState; observedAt:Date; relationship:"same_product"|"unknown"|"conflict"; now?:Date; scanLastError?:string|null }):ObservedAgentFactView[] {
  const age = (input.now ?? new Date()).getTime() - input.observedAt.getTime();
  const coverageLabel = input.scanState === "failed" || input.scanLastError ? "최근 수집 실패 · 이전 확인 정보"
    : input.scanState !== "complete" ? "일부 미확인"
    : !Number.isFinite(age) || age < 0 || age >= 24 * 3600000 ? "에이전트 정보 재확인 필요" : null;
  return input.observations.map(observation => ({
    label: observation.kind === "instruction_file"
      ? /(?:^|\/)CLAUDE\.md$/.test(observation.sourcePath ?? "") ? "Claude 호환 지침 파일 확인" : "에이전트 지침 파일 확인"
      : observation.kind === "model_config" ? observation.routing === "auto" ? "자동 모델 선택 설정" : "모델 설정 확인"
      : observation.kind === "client_config" ? "도구 설정 확인"
      : observation.kind === "commit_attribution" ? "커밋 기여 표기 확인" : "저장소 작성자 사용 주장",
    clientLabel: observation.client ? CLIENTS[observation.client] ?? observation.client : "미확인 (공유 형식)",
    modelLabel: observation.declaredModelId ?? "미확인",
    gatewayLabel: observation.gateway ? GATEWAYS[observation.gateway] ?? observation.gateway : "미확인",
    role: observation.role, scope: observation.scope, sourceUrl:observation.sourceUrl,sourcePath:observation.sourcePath,
    commitSha:observation.commitSha,observedAt:input.observedAt,executionVerified:false,
    coverageLabel,
    relationshipLabel:input.relationship === "same_product" ? null : input.relationship === "conflict" ? "제품과 저장소 관계 충돌" : "제품과 저장소 관계 미확인",
  }));
}

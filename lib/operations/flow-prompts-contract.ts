export const FLOW_PROMPT_STAGES = ['first', 'second', 'human', 'profile', 'publish', 'keywords', 'support'] as const;
export type FlowPromptStage = typeof FLOW_PROMPT_STAGES[number];
export type FlowPromptSection = {
  id: string;
  title: string;
  source: string[];
  system: string | null;
  userTemplate: string | null;
  variables: string[];
  notes: string[];
  version?: string;
  error?: string;
};
export type FlowPromptResponse = {
  stage: FlowPromptStage;
  label: string;
  observedAt: string;
  sections: FlowPromptSection[];
  note: string;
};
export function isFlowPromptStage(value: string): value is FlowPromptStage {
  return (FLOW_PROMPT_STAGES as readonly string[]).includes(value);
}

export type CommitAttribution = {client:string|null;label:string};
const aliases: Record<string,string> = {
  claude:'claude-code','claude code':'claude-code',codex:'codex','openai codex':'codex',
  'qwen-coder':'qwen-code','qwen code':'qwen-code',kimi:'kimi','kimi code':'kimi','kimi cli':'kimi',
  grok:'grok-build','grok build':'grok-build',cursor:'cursor',cline:'cline','roo code':'roo-code',
  opencode:'opencode',aider:'aider','gemini cli':'gemini-cli','github copilot':'github-copilot',
  copilot:'github-copilot',goose:'goose','factory droid':'factory-droid',
};

/** Attribution is a claim in the final Git trailer block, not an authenticated execution record. */
export function parseCommitAttributions(message: string): CommitAttribution[] {
  if (message.length > 128 * 1024) return [];
  const lines = message.replace(/\r\n/g,'\n').trimEnd().split('\n');
  const boundary = lines.lastIndexOf('');
  if (boundary < 0) return [];
  const trailerLines = lines.slice(boundary + 1);
  if (!trailerLines.length || trailerLines.some(line => !/^[A-Za-z][A-Za-z0-9-]*:\s*.+$/.test(line))) return [];
  // A last block inside an unclosed fenced example is still prose, not a trailer.
  let fence: string|null = null;
  for (const line of lines.slice(0,boundary)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (match) { if (!fence) fence = match[1][0]; else if (fence === match[1][0]) fence = null; }
  }
  if (fence) return [];
  const result: CommitAttribution[] = [];
  for (const line of trailerLines) {
    const match = line.match(/^Co-authored-by:\s*([^<>\r\n]+?)\s*<[^<>\s]+@[^<>\s]+>\s*$/i);
    if (!match) continue;
    const label = match[1].trim().replace(/\s+/g,' ');
    if (!label || label.length > 80 || /[\x00-\x1f]|(?:sk-|ghp_|github_pat_)/i.test(label)) continue;
    const client = aliases[label.toLowerCase()] ?? (/^Claude (?:Opus|Sonnet|Haiku) [0-9]+(?:\.[0-9]+)*$/i.test(label) ? 'claude-code' : null);
    if (!result.some(item => item.label === label)) result.push({client,label});
  }
  return result;
}

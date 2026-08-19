import type { EvidenceLevel } from "@/lib/db/product-evidence-schema";
import { makerProvenanceSchema, PROVENANCE_ROLES } from "./contracts";

export const EVIDENCE_LABELS = {
  maker_reported: "메이커 제공",
  repository_evidenced: "저장소 근거",
  nomorevibe_recorded: "NoMoreVibe 기록",
  signed_build: "서명된 빌드 증명",
} as const satisfies Record<EvidenceLevel, string>;

const SENSITIVE_VALUE_PATTERNS = [
  /(?:^|[^\p{L}\p{N}])[_\p{L}][_\p{L}\p{N}]*\s*=/u,
  /\b(?:sk-(?:proj-)?|gh[opsu]_|github_pat_|xox[baprs]-)[a-z0-9_-]{16,}\b/i,
  /\bBearer\s+[a-z0-9._~+/-]+=*/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]*\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PRIVATE_CONTENT_PATTERNS = [
  /\b(?:system|developer|assistant|user)\s+prompt\b/i,
  /\b(?:conversation|chat)\s+log\b/i,
  /\bignore\s+(?:all\s+)?previous\s+instructions\b/i,
  /\byou\s+are\b/i,
  /\b(?:follow|obey|disregard|ignore|reveal)\b.{0,40}\b(?:instructions?|prompts?|secrets?)\b/i,
  /\bSKILL\.md\b/i,
  /(?:^|\s)#{1,6}\s*(?:instructions?|prompt)\b/i,
  /\b(?:name|description|instructions?)\s*:\s*\S/i,
];

const VERSION_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,79}$/i;
const IDENTITY_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const AGENT_METADATA_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+/@()-]*$/u;

function metadataText(value: string, field: string): string {
  const normalizedValue = value.normalize("NFKC");
  if (/\p{C}/u.test(normalizedValue) || /[\u2028\u2029]/u.test(normalizedValue)) {
    throw new Error(`${field} must be one line`);
  }
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(normalizedValue))) {
    throw new Error(`${field} contains sensitive metadata`);
  }
  if (PRIVATE_CONTENT_PATTERNS.some((pattern) => pattern.test(normalizedValue))) {
    throw new Error(`${field} contains private content`);
  }
  const normalized = normalizedValue.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function agentMetadataText(value: string, field: string): string {
  const normalized = metadataText(value, field);
  if (!AGENT_METADATA_PATTERN.test(normalized) || !hasCompactIdentifierTokens(normalized)) {
    throw new Error(`${field} must be a compact identifier`);
  }
  return normalized;
}

function optionalAgentMetadataText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : agentMetadataText(value, field);
}

function normalizedIdentity(value: string, field: string): string {
  const disclosed = metadataText(value, field);
  if (/\s/u.test(disclosed)) throw new Error(`${field} must not contain whitespace`);
  const normalized = disclosed
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  if (!IDENTITY_PATTERN.test(normalized)) throw new Error(`${field} must be a normalized identifier`);
  return normalized;
}

function hasCompactIdentifierTokens(value: string): boolean {
  const tokens = value.split(" ");
  if (tokens.length > 8) return false;
  return tokens.length === 1 || tokens.every((token) => /[A-Z0-9._+/@()-]/.test(token));
}

function normalizedVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = metadataText(value, "skill version");
  if (!VERSION_PATTERN.test(normalized)) throw new Error("invalid skill version");
  return normalized;
}

export type NormalizedProductProvenance = ReturnType<typeof normalizeProductProvenance>;

export function normalizeProductProvenance(
  input: unknown,
  authority: "maker" | "system" = "maker",
) {
  const parsed = makerProvenanceSchema.parse(input);
  const agents = parsed.agents.map((agent) => {
    if (agent.dateFrom && agent.dateTo && agent.dateFrom > agent.dateTo) {
      throw new Error("invalid agent date range");
    }
    assertEvidenceAuthority(agent.evidenceLevel, authority);
    const roles = PROVENANCE_ROLES.filter((role) => agent.roles.includes(role));
    const client = optionalAgentMetadataText(agent.client, "agent client");
    const model = optionalAgentMetadataText(agent.model, "agent model");
    return {
      provider: agentMetadataText(agent.provider, "agent provider"),
      ...(client ? { client } : {}),
      ...(model ? { model } : {}),
      roles,
      ...(agent.commitFrom ? { commitFrom: agent.commitFrom } : {}),
      ...(agent.commitTo ? { commitTo: agent.commitTo } : {}),
      ...(agent.dateFrom ? { dateFrom: agent.dateFrom } : {}),
      ...(agent.dateTo ? { dateTo: agent.dateTo } : {}),
      ...(agent.sourceUrl ? { sourceUrl: agent.sourceUrl } : {}),
      evidenceLevel: agent.evidenceLevel,
    };
  });
  const identities = new Set<string>();
  const skills = parsed.skills.map((skill) => {
    assertEvidenceAuthority(skill.evidenceLevel, authority);
    const namespace = normalizedIdentity(skill.namespace, "skill namespace");
    const name = normalizedIdentity(skill.name, "skill name");
    const version = normalizedVersion(skill.version);
    const identity = [namespace, name, version ?? "", skill.commit ?? ""].join("\0");
    if (identities.has(identity)) throw new Error("duplicate normalized skill identity");
    identities.add(identity);
    return {
      namespace,
      name,
      ...(version ? { version } : {}),
      ...(skill.source ? { source: skill.source } : {}),
      ...(skill.hash ? { hash: skill.hash } : {}),
      ...(skill.commit ? { commit: skill.commit } : {}),
      evidenceLevel: skill.evidenceLevel,
    };
  });
  return { agents, skills };
}

function assertEvidenceAuthority(
  level: EvidenceLevel,
  authority: "maker" | "system",
): void {
  if (level === "signed_build") {
    throw new Error("signed build evidence requires a verified signature ingestion path");
  }
  if (authority === "maker" && level !== "maker_reported") {
    throw new Error("maker authority may only submit maker-reported evidence");
  }
}

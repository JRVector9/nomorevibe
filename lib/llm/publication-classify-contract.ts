import { z } from "zod";

const identity = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
const positive = z.number().int().positive().safe();
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);

/** Publisher authority is carried to the remote process; only locked live rows grant it. */
export const publicationPublisherRoleSchema = z.object({ role: z.literal("publisher"), instanceId: identity(120), bootId: z.uuid(),
  release: identity(200), epoch: positive, kind: z.enum(["primary", "standby"]),
  batchVersion: z.literal(1).optional(), host: z.enum(["m3", "mini", "oracle-osaka-smoke"]).optional(), batchEpoch: positive.optional(),
}).strict().refine(value => value.batchVersion === undefined ? value.host === undefined && value.batchEpoch === undefined
  : value.host !== undefined && value.batchEpoch !== undefined, "invalid_publication_role_batch");
export const publicationClassifyMemberSchema = z.object({ candidateId: positive, repo: identity(200), sourceHash: sha64 }).strict();
export type PublicationClassifyMember = Readonly<z.infer<typeof publicationClassifyMemberSchema>>;
export const publicationClassifyInputSchema = z.object({
  members: z.array(publicationClassifyMemberSchema).min(1).max(10)
    .refine(value => new Set(value.map(member => member.candidateId)).size === value.length
      && new Set(value.map(member => member.repo)).size === value.length, "duplicate_publication_classify_member"),
  provider: z.enum(["claude-cli", "codex-cli"]), model: identity(200), payloadHash: sha64, definitionsHash: sha64,
  configHash: sha64, generation: z.number().int().nonnegative().safe(), configVersion: positive,
}).strict();
export type PublicationClassifyInput = Readonly<z.infer<typeof publicationClassifyInputSchema>>;

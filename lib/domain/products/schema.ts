import { z } from "zod";
import { normalizeHttpUrl } from "@/lib/net/normalize";

export const CATEGORIES = ["Productivity", "Dev", "Design", "Finance", "Other"] as const;
export type Category = (typeof CATEGORIES)[number];

// 입력 길이 상한 — DB 비대와 상세 페이지 수 MB 렌더를 막는다
export const LIMITS = {
  name: 120,
  tagline: 200,
  description: 4000,
  builder: 60,
  makerName: 120,
  repoUrl: 500,
  stackItems: 12,
  stackItemLength: 40,
} as const;

/** http(s)만 허용 — javascript:/data: URI 차단 */
const httpUrl = z
  .string()
  .max(LIMITS.repoUrl)
  .transform((v, ctx) => {
    const normalized = normalizeHttpUrl(v);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "http(s) URL이어야 합니다" });
      return z.NEVER;
    }
    return normalized;
  });

const stack = z
  .array(z.string())
  .transform((items) => items.slice(0, LIMITS.stackItems).map((s) => s.slice(0, LIMITS.stackItemLength)));

/** 등록/수정이 공유하는 제품 필드 정의 — 규칙을 한 곳에서만 바꾸면 된다 */
const productFields = {
  name: z.string().min(1).max(LIMITS.name),
  tagline: z.string().min(1).max(LIMITS.tagline),
  description: z.string().min(1).max(LIMITS.description),
  category: z.enum(CATEGORIES),
  builder: z.string().max(LIMITS.builder),
  stack,
  maker_name: z.string().max(LIMITS.makerName),
  repo_url: httpUrl,
};

export const registerSchema = z.object({
  url: z.string().min(1),
  name: productFields.name,
  tagline: productFields.tagline,
  description: productFields.description,
  category: productFields.category,
  builder: productFields.builder.optional(),
  stack: productFields.stack.optional(),
  maker_name: productFields.maker_name.optional(),
  repo_url: productFields.repo_url.optional(),
});

/** URL은 소유권의 기준이므로 수정 불가 — 새 URL은 새 등록으로 */
export const updateSchema = z
  .object({
    name: productFields.name.optional(),
    tagline: productFields.tagline.optional(),
    description: productFields.description.optional(),
    category: productFields.category.optional(),
    builder: productFields.builder.optional(),
    stack: productFields.stack.optional(),
    maker_name: productFields.maker_name.optional(),
    repo_url: productFields.repo_url.optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;

/** zod 에러를 사용자용 한 줄 메시지로 */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ");
}

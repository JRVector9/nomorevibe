"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveEvidenceSettingsValue } from "@/lib/domain/evidence/admin";
import { evidenceSettingsSchema } from "@/lib/domain/evidence/settings";

export type EvidenceActionState = {
  ok?: true;
  issues?: string[];
} | null;

const FIELDS = {
  githubFactsHours: "GitHub 사실 갱신",
  releaseFeedHours: "릴리스·피드 갱신",
  linkCheckHours: "링크·미디어 확인",
  staleAfterIntervals: "오래됨 판정",
  maxRetries: "최대 재시도",
  batchSize: "한 번에 처리할 배치",
  starDigestAbsolute: "별 증가 절대값",
  starDigestPercent: "별 증가율",
} as const;

export async function saveEvidenceSettings(
  _previous: EvidenceActionState,
  form: FormData,
): Promise<EvidenceActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  const raw = Object.fromEntries(Object.keys(FIELDS).map((field) => [
    field,
    Number(String(form.get(field) ?? "")),
  ]));
  const nonFinite = Object.entries(raw).find(([, value]) => !Number.isFinite(value));
  if (nonFinite) return { issues: [`${FIELDS[nonFinite[0] as keyof typeof FIELDS]} 값을 확인해주세요.`] };

  const parsed = evidenceSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => {
        const field = issue.path[0] as keyof typeof FIELDS | undefined;
        return `${field ? FIELDS[field] : "설정"}: ${issue.message}`;
      }),
    };
  }

  await saveEvidenceSettingsValue(parsed.data, admin.login);
  revalidatePath("/admin/evidence");
  revalidatePath("/admin/status");
  return { ok: true };
}

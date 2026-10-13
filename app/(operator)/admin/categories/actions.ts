"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings } from "@/lib/crawl/settings";
import { CATEGORIES, type Category } from "@/lib/domain/products/categories";

export type CategoryActionState = { ok?: true; issues?: string[] } | null;

/** 한 줄에 하나씩 적는다. 빈 줄은 버린다 — 붙여넣기로 생긴 공백이 규격 위반이 되면 안 된다 */
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 카테고리 기준 저장.
 *
 * 화면에 있는 카테고리만 보내고 나머지는 저장된 값을 유지한다 (saveSettings가 병합한다).
 * 서버 액션은 URL 없이 호출될 수 있으므로 proxy와 별개로 자격을 다시 확인한다.
 */
export async function saveCategoryDefinitions(
  _previous: CategoryActionState,
  form: FormData,
): Promise<CategoryActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  const name = String(form.get("category") ?? "");
  if (!CATEGORIES.includes(name as Category)) return { issues: ["알 수 없는 카테고리입니다."] };

  const result = await saveSettings({
    classify: {
      definitions: {
        [name]: {
          summary: String(form.get("summary") ?? "").trim(),
          include: lines(form.get("include")),
          exclude: lines(form.get("exclude")),
        },
      },
    },
  }, admin.login);

  if (!result.ok) return { issues: result.issues };

  revalidatePath("/admin/categories");
  return { ok: true };
}

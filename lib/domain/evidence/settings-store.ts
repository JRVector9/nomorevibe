import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { evidenceSettings } from "@/lib/db/schema";
import { evidenceSettingsSchema, type EvidenceSettings } from "./settings";

/**
 * 저장된 근거 설정 한 행.
 *
 * refresh.ts에 있을 때는 이 세 줄을 읽으려고 상세 페이지가 github·feeds·links provider와
 * net/fetch, media까지 통째로 import 그래프에 끌고 들어왔다. 읽기만 하는 것은 여기 둔다.
 */
export async function currentEvidenceSettings(): Promise<EvidenceSettings> {
  const row = await db.query.evidenceSettings.findFirst({ where: eq(evidenceSettings.id, 1) });
  return evidenceSettingsSchema.parse(row?.values ?? {});
}

import { publicRead } from "@/lib/domain/products/public-reads";
import { getSeasonByKey } from "./view";

/** 시즌 랭킹 읽기 — 시즌 화면과 채우기 API(/api/rankings/[key])가 같은 열쇠로 30초 함께 쓴다(public-reads.ts) */
export function readSeasonByKey(key: string): ReturnType<typeof getSeasonByKey> {
  return publicRead("list", ["season-ranking", key], () => getSeasonByKey(key));
}

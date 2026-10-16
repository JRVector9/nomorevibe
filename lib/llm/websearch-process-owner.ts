import { randomUUID } from "node:crypto";
import { serviceInstanceId } from "@/lib/operations/instance";
import { websearchProcessOwnerSchema, type WebsearchProcessOwner } from "./capacity";

/**
 * 공개 검색어 번역의 실제 호출 주인 — 이 프로세스 자신이다. 역할·잡 리스를 빌리지 않는다.
 *
 * 인스턴스는 운영이 넣는 SERVICE_INSTANCE_ID(lib/operations/instance.ts), 릴리스는 RELEASE_TAG(없으면 NEXT_DEPLOYMENT_ID)다.
 * boot 는 프로세스가 이 모듈을 처음 읽을 때 한 번 만들어 globalThis 에 둔다 — 모듈을 다시 읽어도, 요청마다도 바뀌지 않는다.
 * 요청·헤더·검색어에서 받지 않는다. 설정이 없거나 잘못되면 null 이고, 부르는 쪽은 호출하지 않고 미룬다.
 */
const globalOwner = globalThis as typeof globalThis & { noMoreVibeWebsearchBootId?: string };
globalOwner.noMoreVibeWebsearchBootId ??= randomUUID();

export function websearchProcessOwner(env: Readonly<Record<string, string | undefined>> = process.env): WebsearchProcessOwner | null {
  let instanceId: string | null;
  try { instanceId = serviceInstanceId(env); } catch { return null; }
  const release = env.RELEASE_TAG?.trim() || env.NEXT_DEPLOYMENT_ID?.trim();
  const owner = websearchProcessOwnerSchema.safeParse({ instanceId, bootId: globalOwner.noMoreVibeWebsearchBootId, release });
  return owner.success ? Object.freeze(owner.data) : null;
}

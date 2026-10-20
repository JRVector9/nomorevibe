import "server-only";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";

/** 마이페이지 서버 화면의 로그인 확인 — 로그인 기능이 꺼져 있거나 세션이 없으면 null(로그아웃 화면) */
export async function getMeSession() {
  try {
    return await getPublicSession();
  } catch {
    return null;
  }
}

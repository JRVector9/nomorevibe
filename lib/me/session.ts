import "server-only";
import { cache } from "react";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";

/** 마이페이지 서버 화면의 로그인 확인 — 로그인 기능이 꺼져 있거나 세션이 없으면 null(로그아웃 화면). 한 요청 안의 틀·탭이 한 번만 읽는다 */
export const getMeSession = cache(async () => {
  try {
    return await getPublicSession();
  } catch {
    return null;
  }
});

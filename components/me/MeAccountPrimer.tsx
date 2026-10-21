"use client";

import { primeMeAccount, type MeAccount } from "./account-store";

/** 마이페이지 틀이 서버에서 읽은 계정을 머리(account-store)에 넘긴다 — 같은 화면에서 로그인 상태를 다시 묻지 않게. 그리는 것은 없다 */
export function MeAccountPrimer({ account }: { account: MeAccount }) {
  primeMeAccount(account);
  return null;
}

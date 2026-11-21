"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { denyMaintainerEmailAddressAction } from "./actions";

/**
 * 제작자 이메일 「주소로 거부」(관리자 전용, 2026-11-21 소유자 결정 — 권장안) — 본인이 수집하지 말아 달라고 알려 온 주소.
 * 서버가 해시만 계산해 거부 목록에 넣고 모든 저장소의 같은 주소를 지운다. 응답은 수만 돌려주고 주소를 다시 보이지 않는다.
 * 입력은 제어하지 않는 칸이라 동작이 끝나면 React 가 양식을 비운다. 브라우저 자동 완성에도 남기지 않는다.
 */
export function MaintainerEmailOptOut() {
  const router = useRouter();
  const [state, action, pending] = useActionState(denyMaintainerEmailAddressAction, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return (
    <form action={action} className="mt" data-admin-maintainer-email-opt-out="">
      <div className="field">
        <label htmlFor="maintainer-email-opt-out">주소로 거부 (본인 요청)</label>
        <p>본인이 알려 온 주소를 적으면 모든 저장소에서 지우고 다시 모으지 않습니다. 주소는 저장하지 않고 해시만 남기며, 작업 로그에도 주소를 남기지 않습니다.</p>
        <div className="flex">
          <input id="maintainer-email-opt-out" name="address" type="text" inputMode="email" autoComplete="off" spellCheck={false}
            required maxLength={254} placeholder="주소" />
          <button className="button" disabled={pending}>{pending ? "처리 중" : "거부 목록에 넣기"}</button>
        </div>
      </div>
      <div aria-live="polite">
        {state?.ok && <p>거부 목록에 넣었습니다{state.alreadyDenied ? "(이미 있었음)" : ""} · 지운 행 {state.deletedRows ?? 0}</p>}
        {state?.issues?.map((issue) => <p key={issue} className="text-down">{issue}</p>)}
      </div>
    </form>
  );
}

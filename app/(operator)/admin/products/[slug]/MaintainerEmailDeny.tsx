"use client";

import { useRouter } from "next/navigation";
import { ConfirmAction } from "../../components/ConfirmAction";
import { resultError, useAdminToast } from "../../components/Toast";
import { denyMaintainerEmailAction } from "./actions";

/**
 * 제작자 이메일 한 줄의 「지우고 다시 모으지 않기」(관리자 전용, 0194). 주소는 받지 않는다 — 거부 목록 열쇠(denyKey)와 가린 주소(masked)만.
 * 지우면 모든 저장소의 같은 주소가 사라지고, 다음 수집부터 다시 모으지 않는다. 되돌리기는 없다.
 */
export function MaintainerEmailDeny({ slug, denyKey, masked }: { slug: string; denyKey: string; masked: string }) {
  const toast = useAdminToast();
  const router = useRouter();
  return (
    <ConfirmAction
      title="이 주소를 지우고 다시 모으지 않습니다"
      targets={[masked]}
      summary={<ul className="list-disc pl-5 text-[13px] leading-[1.6]">
        <li>모든 저장소에서 이 주소를 바로 지웁니다.</li>
        <li>주소 대신 해시만 거부 목록에 남겨, 다음 수집부터 다시 모으지 않습니다.</li>
        <li>되돌릴 수 없습니다. 작업 로그에는 주소를 남기지 않습니다.</li>
      </ul>}
      confirmLabel="지우고 다시 모으지 않기"
      onConfirm={async () => {
        const form = new FormData();
        form.set("slug", slug);
        form.set("denyKey", denyKey);
        const result = await denyMaintainerEmailAction(null, form);
        if (!resultError(result)) {
          toast.show({ message: `지움 · ${masked} · ${result?.deletedRows ?? 0}행`, tone: "ok" });
          router.refresh();
        }
        return result;
      }}
      trigger={(open) => <button type="button" onClick={open} aria-haspopup="dialog" className="text-button">지우고 다시 모으지 않기</button>}
    />
  );
}

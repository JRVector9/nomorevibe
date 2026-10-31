import Link from "next/link";

/**
 * 장비 한도(PR 1b) 묶음 — 장비별 칸 수·역할 순서·빌려 쓰기는 /admin/models/devices 가 맡는다. 거기에는 "읽은 판"이 없다:
 * 입장 판정이 트랜잭션 안에서 표(model_capacity_devices·_roles)를 읽어 저장 즉시 다음 입장부터 쓰이고 DRAIN·배포가 없다.
 */
export function DevicesPlaceholder() {
  return <div className="grid gap-2 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <p className="font-semibold">장비별 칸 수·낮은 순위 상한·유휴 판정·비워 둘 칸·역할 순서(우선순위)·빌려 쓰기는 「장비 한도」 화면에서 장비마다 저장합니다.</p>
    <p className="text-[13px] text-fg-3">장비 표는 입장 판정이 트랜잭션 안에서 바로 읽어 저장 즉시 다음 입장부터 쓰이므로 이 화면의 「읽은 판」 줄에는 들지 않습니다(DRAIN·배포 불필요).
      장비마다 판(version)·마지막 저장이 따로 있고, 저장은 작업 로그 <code>model-capacity-device-save</code> 에 남습니다.
      모델 자체의 상한은 <Link href="/admin/models/contracts" className="underline">모델 연결 → 등록부 덮어쓰기</Link>에서 바꿉니다.</p>
    <Link href="/admin/models/devices" prefetch={false} className="text-[13px] font-semibold text-accent-ink">장비 한도 화면 →</Link>
  </div>;
}

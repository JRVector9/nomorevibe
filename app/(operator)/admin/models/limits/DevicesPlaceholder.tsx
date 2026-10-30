import Link from "next/link";

/** 장비 한도(PR 1b) 자리 — 장비별 칸 수·역할 순서·빌려 쓰기는 /admin/models/devices 가 맡는다. 거기에는 "읽은 판"이 없다(입장 판정이 TX 안에서 표를 읽는다). */
export function DevicesPlaceholder() {
  return <div className="grid gap-2 rounded-xl border border-dashed border-line bg-bg-card p-5 text-[14px]">
    <p className="font-semibold">PR 1b 에서 이 자리에 장비별 칸 수·역할 순서·빌려 쓰기(<code>/admin/models/devices</code>)</p>
    <p className="text-[13px] text-fg-3">장비 표(model_capacity_devices)는 입장 판정이 트랜잭션 안에서 바로 읽어 저장 즉시 쓰이므로 여기의 「읽은 판」 줄에는 들지 않습니다.
      지금 장비·모델 자체의 상한은 <Link href="/admin/models/contracts" className="underline">모델 연결 → 등록부 덮어쓰기</Link>에서 바꿉니다.</p>
    <Link href="/admin/models/devices" prefetch={false} className="text-[13px] font-semibold text-accent-ink">장비 한도 화면(준비 중) →</Link>
  </div>;
}

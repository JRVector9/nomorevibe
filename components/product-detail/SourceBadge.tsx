const TONES: Record<string, string> = {
  "공식 출처에서 확인": "border-up/30 bg-up/10 text-up",
  "GitHub에서 확인": "border-up/30 bg-up/10 text-up",
  // 코랄 글자는 연한 코랄 바탕에서 3.7:1 — 우리 기록은 중립 배지로 둔다(흰 바탕에 짙은 코랄 4.9:1)
  "NoMoreVibe 기록": "border-line bg-bg-card text-accent-ink",
  "메이커 제공": "border-amber-600/30 bg-amber-50 text-amber-800",
  "메이커 제공·미검증": "border-amber-600/30 bg-amber-50 text-amber-800",
  "자동 감지": "border-blue-600/25 bg-blue-50 text-blue-700",
  "서명된 빌드": "border-teal-600/30 bg-teal-50 text-teal-800",
};

export function SourceBadge({ label }: { label: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[13px] font-semibold ${
      TONES[label] ?? "border-line bg-bg-soft text-fg-2"
    }`}>
      {label}
    </span>
  );
}

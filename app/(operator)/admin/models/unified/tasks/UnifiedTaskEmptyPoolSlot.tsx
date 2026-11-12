/** Empty visual slot only: disabled, unnamed and independent of the saved member draft. */
export function UnifiedTaskEmptyPoolSlot({ index }: { index: number }) {
  return <label className="ut-slot ut-empty-slot"><input type="number" value="1" disabled readOnly
    aria-label={`모델 ${index + 1} 동시 칸 수`} data-empty-pool-slot="true" /><span>칸</span></label>;
}

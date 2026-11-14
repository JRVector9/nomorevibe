/** Public waiting UI stays text-free in HTML and RSC; aria-busy carries its state. */
export function PublicSkeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return <div aria-busy="true" className={className}>
    <div aria-hidden="true" className="flex flex-col gap-2 motion-safe:animate-pulse">
      {Array.from({ length: lines }, (_, index) => <div key={index}
        className={`h-4 max-w-full rounded bg-bg-soft ${index === lines - 1 ? "w-2/3" : "w-full"}`} />)}
    </div>
  </div>;
}

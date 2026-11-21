"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function SearchTranslationRetry({ label }: { label: string }) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();

  return <button type="button" className="secondary mb-5" disabled={refreshing} aria-busy={refreshing}
    onClick={() => startTransition(() => router.refresh())}>
    {label}
  </button>;
}

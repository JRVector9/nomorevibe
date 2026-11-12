"use client";

import { useEffect } from "react";
import Link from "next/link";
import { legacyTasksHref } from "./legacy-navigation";

export function LegacyTasksRedirect({ params }: { params: Record<string, string | string[] | undefined> }) {
  const fallback = legacyTasksHref(params);
  useEffect(() => { window.location.replace(legacyTasksHref(params, window.location.hash)); }, [params]);
  return <p role="status" className="notice">통합 모델 화면으로 이동합니다. <Link href={fallback} prefetch={false}>모델·작업 배정 열기 →</Link></p>;
}

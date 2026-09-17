"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
/** Design worktree preview has its own shell; public routes retain the original chrome. */
export function LegacyChrome({ children }: { children: ReactNode }) {
  const path = usePathname();
  return path === "/design" || path.startsWith("/design/") ? null : children;
}

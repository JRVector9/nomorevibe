import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DesignRouter } from "@/components/design/DesignRouter";
import { validDesignPath } from "@/components/design/data";
export default async function DesignPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const path = (await params).path?.join("/") ?? "";
  if (!validDesignPath(path)) notFound();
  return (
    <Suspense fallback={<p>화면을 불러오고 있습니다.</p>}>
      <DesignRouter key={path} path={path} />
    </Suspense>
  );
}

/** Only committed or independently observed existing images finish an apply run. */
export function completedThumbnailIds(receipt: string): Set<number> {
 const done = new Set<number>();
 for (const line of receipt.split("\n").filter(Boolean)) {
  const row = JSON.parse(line) as { id: number; status: string };
  if (row.status === "applied" || row.status === "preexisting") done.add(row.id);
 }
 return done;
}

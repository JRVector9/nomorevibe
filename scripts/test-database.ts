/** Destructive fixture runners must never accept a service database or a libpq host override. */
export function assertLocalTestDatabase(value: string): void {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.pathname !== "/nomorevibe_test" || url.search || url.hash) throw new Error();
  } catch { throw new Error("local_test_database_required"); }
}

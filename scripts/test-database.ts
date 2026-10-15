/** Destructive fixture runners must never accept a service database or a libpq host override. */
export function assertLocalTestDatabase(value: string): void {
  try {
    const url = new URL(value);
    // Match postgres.js's first-@ host split, not only WHATWG's last-@ hostname.
    const authority = value.slice(value.indexOf("://") + 3).split(/[?/]/)[0];
    const driverHost = authority.slice(authority.indexOf("@") + 1);
    if (driverHost !== url.host || !["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.pathname !== "/nomorevibe_test" || url.search || url.hash) throw new Error();
  } catch { throw new Error("local_test_database_required"); }
}

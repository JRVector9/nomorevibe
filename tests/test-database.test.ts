import { expect, it } from "vitest";
import { assertLocalTestDatabase } from "@/scripts/test-database";
it("allows only an explicit loopback test database, never production or URL socket overrides", () => {
  expect(() => assertLocalTestDatabase("postgres://test:test@127.0.0.1:55435/nomorevibe_test")).not.toThrow();
  for (const url of ["postgres://user@100.99.209.55/nomorevibe_test", "postgres://user@localhost/nomorevibe", "postgres://user@localhost/nomorevibe_test?host=prod", "https://localhost/nomorevibe_test", "invalid"])
    expect(() => assertLocalTestDatabase(url)).toThrow("local_test_database_required");
});

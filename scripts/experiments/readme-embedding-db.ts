import { execFileSync } from "node:child_process";
import postgres from "postgres";

export function openReadmeExperimentDatabase(max = 1): postgres.Sql {
  const connectionString = process.env.NMV_README_DB_URL;
  if (!connectionString) {
    throw new Error("Set NMV_README_DB_URL to the dedicated experiment container's local connection.");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("NMV_README_DB_URL is not a valid PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username !== "nomorevibe" ||
    url.pathname !== "/nomorevibe_test" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NMV_README_DB_URL must identify the loopback nomorevibe_test database on an explicit port.");
  }

  let binding: string;
  try {
    binding = execFileSync("docker", ["port", "nmv-readme-exp-pg", "5432/tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    throw new Error("Could not verify the published port of the nmv-readme-exp-pg container.");
  }
  if (binding !== `127.0.0.1:${url.port}`) {
    throw new Error("NMV_README_DB_URL must match the loopback port of nmv-readme-exp-pg.");
  }

  return postgres(connectionString, { max, connect_timeout: 5 });
}

export function migrationDatabaseUrl(env = process.env) {
  return env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL;
}
